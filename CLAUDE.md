# CLAUDE.md

Guidance for AI assistants working in this repository.

## What this is

`multiplayer-cli` (`mpx`) turns one AI coding session into a room several people
share. The host runs the session on their own machine and account; everyone else
is a thin seat that proposes and votes. Nothing reaches the model until the room
agrees, and every decision is written to an append-only audit log.

TypeScript, ESM, Node ≥ 20.11. One runtime dependency (`ws`). No framework, no
bundler for the CLI, no linter.

## Commands

```bash
npm install
npm run build          # tsc -p tsconfig.json && node scripts/copy-web.mjs
npm test               # builds first, then node --test on dist/test/*.test.js
npm start              # build, then run the CLI

node dist/src/cli.js share --backend echo --policy pair   # a real room, offline, free

npm run sync           # regenerate the derived integration files
npm run sync -- --check  # verify them instead of writing (this is what CI runs)
npm run build:extension  # typecheck + esbuild bundle the VS Code extension
npm run test:vscode      # launch a real VS Code and activate the extension
```

`npm test` currently runs **317 tests**, all passing. It needs no API key and
no coding CLI. One extension test skips unless `npm run build:extension` has
been run first. The browser-seat
tests need Playwright and a Chromium and skip themselves cleanly without them:

```bash
npm install playwright && npx playwright install chromium
```

There is no ESLint, Prettier, or format script. Match the surrounding style.

## Architecture

One room server owns exactly one AI session. Everything else is arranged around
that fact.

```
   alice ─┐
   bob   ─┼──► room server ──► consent gate ──► the one AI session
   carol ─┘        ▲                 │
                   └── votes ────────┘
```

### The seams

| Path | What it owns |
|---|---|
| `src/protocol.ts` | The wire contract: every type, `ClientMessage`, `ServerMessage`, `PROTOCOL_VERSION` |
| `src/core/crypto.ts` | AES-256-GCM frames, HKDF, the ECDH handshake primitives |
| `src/core/secure.ts` | One end of an encrypted link — handshake then sealed frames |
| `src/core/gate.ts` | The consent decision. **Pure**: same inputs, same verdict, `now` passed in |
| `src/core/policy.ts` | Presets (`solo`/`pair`/`team`/`strict`/`host`/`round-robin`) and `key=value` overrides |
| `src/core/room.ts` | Participants, proposals, timers, the queue, crossroads, lane state |
| `src/core/transcript.ts` | Append-only JSONL audit log, `.mpx/<room>.jsonl` |
| `src/core/worktree.ts` | Git worktrees, one per lane |
| `src/core/preview.ts` | A running copy of the app per lane, so a vote is on the thing not a diffstat |
| `src/core/overlap.ts` | Warns when two split lanes touched one file |
| `src/core/crossroads.ts` | The agent asking the room to pick a direction |
| `src/server/server.ts` | The room, wired to the session. The largest file, and the integration point |
| `src/server/transport.ts` | How seats arrive: a local port, or a relay dialled out to |
| `src/server/relay.ts` | The relay — a pipe that knows as little as possible |
| `src/server/web.ts` | Serves the browser seat and the invite page |
| `src/server/lanes.ts` | Racing and splitting: N backends, N worktrees, N results |
| `src/server/runners.ts` | Routing turns across seats' accounts (experimental, `--pool`) |
| `src/agent/index.ts` | Backend registry, `createBackend`, the multiplayer system prompt |
| `src/agent/profiles.ts` | One small profile per coding CLI: argv in, room events out |
| `src/agent/process.ts` | The shared process driver those profiles plug into |
| `src/agent/anthropic.ts` | The API backend — the one where mpx owns the agent loop |
| `src/agent/claudeCode.ts` | One long-lived `claude` process |
| `src/agent/echo.ts` | Offline stand-in; a full dry run of a room |
| `src/agent/tools.ts` | Tool surface + risk classification for the `anthropic` backend |
| `src/agent/limits.ts` | Recognising "this account is out of capacity" across tools that all phrase it differently |
| `src/client/connection.ts` | Reconnecting WebSocket client |
| `src/client/commands.ts` | Slash-command parsing. Pure: text in, `ClientMessage` or local action out |
| `src/client/roomView.ts` | View model for any graphical seat — **editor-free, so it is testable** |
| `src/client/layout.ts` | The screen as a pure function of the room: `rows` lines of `cols` columns |
| `src/client/screen.ts` | Diffed terminal writes; injected `Writer`, so no terminal needed to test |
| `src/client/editor.ts` | The input line as a pure function of keystrokes |
| `src/client/fullscreen.ts` | The full-screen panes seat |
| `src/client/tui.ts` | The one-column `--plain` seat |
| `src/client/runner.ts` | Offers this machine and this person's subscription to the room |
| `src/client/web/session.html` | The browser seat: one self-contained page, no build step |
| `src/cli.ts` | Argument parsing and command dispatch for every `mpx` subcommand |
| `extension/` | The VS Code / Cursor seat — glue around `roomView` |
| `skills/multiplayer/SKILL.md` | The Claude Code skill, and the **source** for the Gemini context file |

### Data flow of a turn

1. A seat types text → `client/commands.ts` turns it into `{t:"propose"}`.
2. `core/room.ts` creates a `Proposal`, broadcasts it with a `Tally`.
3. Votes arrive; `core/gate.ts` re-evaluates. A veto is immediate; a deadline
   can approve on silence when the policy allows it.
4. On approval the server runs the turn on the active backend (or dispatches it
   to a runner seat), streaming `delta` messages to everyone.
5. On the `anthropic` and `echo` backends, the model's own tool calls become
   proposals too, and the turn genuinely blocks until the room answers. A
   denial goes back to the model as a decision, not an error.
6. Everything the room saw is appended to the transcript.

### Backends

Eleven: `anthropic`, `claude-code`, `codex`, `copilot`, `opencode`,
`opencode-json`, `gemini`, `cursor`, `aider`, `amp`, `echo`. Only `anthropic`
and `echo` gate the model's tool calls (`GATES_TOOLS` in `src/agent/index.ts`) —
those are the two where mpx owns the agent loop. The others run their own loops
and their own permission systems apply.

Adding a CLI means adding a **profile** to `src/agent/profiles.ts`, not a class.
`ProcessBackend` already handles spawning, streaming, interrupts, exit codes and
error surfacing. See `docs/backends.md` for the shape.

The Anthropic SDK is an **optional** peer dependency (12MB for the one backend
most rooms never use). `test/optional-sdk.test.ts` pins that it must not be
reachable from an import — only from actually using that backend. Never add a
top-level `import Anthropic from "@anthropic-ai/sdk"` outside a type position.

## House rules

These are load-bearing; several exist because breaking them caused a shipped
bug.

**Keep `gate.ts` pure.** Same inputs, same verdict, with `now` passed in. Every
voting rule is a unit test, and that is only possible because it never reaches
for a clock. The same discipline applies to `layout.ts`, `editor.ts`,
`commands.ts` and `roomView.ts` — the logic worth testing lives outside the
things that need a terminal or an editor.

**Fail closed.** An unrecognised tool is classified as the most dangerous kind.
An unknown policy key is an error, not a silent no-op. A vote that cannot be
decided stays open rather than defaulting to send.

**Test against stubs, not against the real tool.** CLI adapters are covered by
stub binaries that emit exactly what each tool documents, recording the argv
they were called with. No credentials, no spend, runs in CI.

**One copy, generated.** A number or paragraph living in two files has caused
three bugs here. `skills/multiplayer/SKILL.md` is the only copy anyone edits;
`gemini-extension/GEMINI.md` is generated from it, and the version in
`gemini-extension/gemini-extension.json`, `.claude-plugin/plugin.json` and
`extension/package.json` all come from `package.json`. After touching any of
those, run `npm run sync`. CI runs `npm run sync -- --check` and a stale copy
fails the build.

**Say what changed and why in the commit message.** Commits here are prose, not
conventional-commit prefixes: an imperative one-line subject, then paragraphs
explaining the reasoning and what was verified. The reasoning is the expensive
part to reconstruct later. Look at `git log` before writing one.

**Bumping the protocol.** `PROTOCOL_VERSION` in `src/protocol.ts` is checked on
connect; older clients are refused. Bump it for any incompatible change and add
a line to the comment above it saying what that version added.

**Keep the three seats level.** The terminal, browser (`src/client/web/session.html`)
and editor (`extension/`) seats have drifted apart before — `/split` answered
"unknown command" in two of them for a release. A new command or a new piece of
room state usually needs handling in all three.

## TypeScript conventions

- ESM with `module: NodeNext`. **Relative imports must carry the `.js`
  extension**, even from `.ts` files: `import { Room } from "./core/room.js"`.
- `strict` and `noUncheckedIndexedAccess` are on. Indexing an array or record
  gives you `T | undefined`; handle it rather than reaching for `!` by habit.
- `rootDir` is `.`, so the build emits `dist/src/…` and `dist/test/…`. The `bin`
  entry is `dist/src/cli.js`.
- Comments here explain *why*, often at length, and are part of the house style.
  Match that density rather than stripping it.

## Tests

`node:test`, run against the compiled output in `dist/test/`.

| File | Covers |
|---|---|
| `units.test.ts` | Commands, args, ansi, transcript, tool risk, protocol codec |
| `gate.test.ts` | Every voting rule, one test each |
| `room.test.ts` | Proposals, timers, queue, presence |
| `e2e.test.ts` | A whole room against a scripted backend |
| `backends.test.ts` | Every CLI profile against stub binaries, argv included |
| `handshake.test.ts` | The ECDH exchange, and that a finished handshake proves nothing on its own |
| `crypto.test.ts` | Sealing, nonces, replay guards |
| `relay.test.ts` | The relay's limits, rate limiting, room registration |
| `share.test.ts` | Link construction, tokens, transports |
| `lanes.test.ts` | Racing and splitting, worktrees, landing |
| `overlap.test.ts` | Two split lanes claiming one file |
| `preview.test.ts` | Lane previews, started through a shell so process-group kill is really tested |
| `crossroads.test.ts` | Parsing and ratifying a fork |
| `runners.test.ts` / `failover.test.ts` | Account pooling and handoff on a usage limit |
| `screen.test.ts` | The layout and the input line, as strings |
| `extension.test.ts` | The editor view model, plus the integration drift checks |
| `browser.test.ts` | The browser seat in a real Chromium (skips without Playwright) |
| `optional-sdk.test.ts` | The Anthropic SDK stays unreachable unless used |

Before opening a PR: a green `npm test`, and mention anything you could not
verify.

## CI

`.github/workflows/ci.yml` has four jobs:

- **test** — build and test on Node 20.11, 22 and 24.
- **extension** — `sync-integrations.mjs --check`, build the bundle, run the
  extension test, package the `.vsix`, then `check-vsix.mjs` asserts the package
  contains what it needs (`dist/extension.js`, `dist/session.html`) and none of
  what it should not (tests, sources, source maps).
- **vscode** — activates the extension in a real VS Code under `xvfb`.
- **browser** — installs Chromium and runs the suite with the browser tests live.

`.github/workflows/release.yml` is `workflow_dispatch` only. It checks the
requested version matches `package.json`, runs the full suite, tags, cuts the
release, and publishes to npm and Open VSX — each publish step skipping itself
when its secret is absent. Releases are cut from Actions, never from a laptop.

## Documentation

`docs/` is written for users and is kept current; read it before changing
behaviour it describes.

`getting-started` · `the-screen` · `deciding` · `backends` · `relay` ·
`security` · `racing` · `splitting` · `crossroads` · `pooling` · `editor` ·
`agents` · `protocol`

`CHANGELOG.md` gets a section per release, in the same explain-the-why prose as
the commits. `docs/index.html` is the landing page.

## Things worth knowing before you touch them

- **The token is a key, not a password.** It authenticates an ephemeral ECDH
  exchange and never travels on the wire. Do not add a code path that sends it
  or logs it. In the shareable `http://…/s/<room>` link it rides in the
  *fragment*, which browsers never send to a server; keep it there.
- **Racing needs a git repository.** `--lanes 0` turns it off. A room outside a
  repo works this out at startup (`detectRepo`) and stores *why*, so `/race`
  explains itself instead of failing at the moment someone tries it.
- **Previews are started detached** so the whole process group can be killed;
  `npm run dev` is a shell that spawns a server, and killing the shell alone
  orphans it holding the port.
- **`src/client/web/session.html` has no build step** and fetches nothing — a
  test asserts it stays one self-contained page. Keep it that way.
- **`scripts/copy-web.mjs` exists because tsc does not copy assets.** If you add
  a runtime asset, it needs copying too.
- **`mpx --version` reads `package.json`** rather than a second constant,
  because for two releases it did not, and lied.
