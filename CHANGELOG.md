# Changelog

## 0.11.0

- **A landing page** at `docs/index.html`, served by GitHub Pages from `/docs`.
  Self-contained: no build step, no framework, no external request except the
  recording it embeds.
- **The README demo is recorded, not drawn.** `scripts/record-demo.sh` drives
  the real binary in a real pty — two people in a room, an agent stopping at a
  fork, the room picking a direction — and renders the frames to an animated
  SVG. The demo cannot drift from the tool, because it is the tool's output.

- **Crossroads.** The agent stops at a genuine fork and asks the room which way
  to go, before spending the work. Every other gate is the room interrupting
  the agent; this is the agent asking the room, which is the one direction the
  design was missing.
  - Racing answers "which approach?" by building all of them. This answers it
    by asking — the only thing that works when the fork is about intent rather
    than code. *"Must v1 keep working?"* is a decision, not a fact.
  - Any backend can raise one, by writing a `[[crossroads]]` block; the block
    is lifted out of the transcript rather than read to the room as prose. The
    built-in `anthropic` backend gets a real `ask_room` tool instead.
  - Only some backends can be held mid-turn, and the room says which is
    happening rather than blurring it: `anthropic` genuinely pauses, and a CLI
    that has already streamed its answer gets the room's decision as its next
    message.
  - `/ask <q> | <a> | <b>` puts a fork to the room by hand, on any backend.
  - Voting every option down is a real outcome, and the agent is told so
    instead of being left waiting.
  - Its own gate, `choice.*`. No timer in any preset: silence is consent for a
    question, not for a direction.
  - Proposed by Fathy's collaborator.
- Protocol 5.

## 0.10.1

- **Fixed: `mpx --version` had been reporting 0.8.0 for two releases.** The
  number was written down in two places, so of course they disagreed. It is now
  read from the manifest, and a test fails if the two ever differ again.
- `mpx policies` shows the landing gate alongside prompts and tools — lanes
  have had their own gate since 0.9.0 and this is where people look for it.
- **Releases are cut by CI.** `.github/workflows/release.yml` tags the commit,
  writes the release notes from this changelog, and attaches the npm tarball
  and the packaged extension. It publishes to npm and Open VSX when the
  `NPM_TOKEN` and `OVSX_TOKEN` secrets exist, and says so plainly when they do
  not — rather than failing, or pretending it published something.
- **CI now runs the extension inside a real VS Code**, headless under xvfb.
  The stubbed-API tests prove its logic; only a real editor proves VS Code will
  load the bundle and activate it — which is exactly the failure that once got
  past every other test.

## 0.10.0

- **A full-screen terminal seat.** The model's reply on the left; who is here,
  what is waiting on your vote and how the lanes are doing in a pane beside it.
  Racing is the reason: "which lane is winning" is standing information, and it
  should not scroll away under the model's next paragraph.
  - Shell line editing, command completion on `Tab`, input history on `↑`/`↓`,
    and `PgUp`/`PgDn` scrollback that new output does not yank you out of.
  - Only changed lines are rewritten, so typing costs bytes rather than
    kilobytes — which is the difference between usable and unusable over ssh.
  - `--plain` (or `MPX_PLAIN=1`) keeps the single scrolling column, and so does
    a pipe, `TERM=dumb`, or a window under 60x14.
- The layout and the line editor are pure functions, so the terminal UI is
  tested by reading strings rather than by looking at it.
- Fixed: pressing `↓` after editing a recalled history entry wiped the line.
- Fixed: the browser tests launched a Chromium per test, which wedged a
  constrained machine roughly one run in three. One browser for the file.

## 0.9.0

- **Racing.** `/race 3 <prompt>` runs one approved prompt in three parallel git
  worktrees, each agent on its own branch, and then puts the diffs to the room:
  one proposal per lane, and approving one merges it. A vote can tell you
  whether to send a prompt; it cannot tell you whether the answer was any good,
  and this is how a room finds that out without arguing about it first.
  - Landing has its own gate (`lane.*`), with no timer in any preset — silence
    is consent for a question, not for a merge.
  - The branches lanes leave behind are kept and named, never deleted.
  - `--lanes n` sets the room's default (0 turns it off), `--lane-setup <cmd>`
    runs in each fresh checkout so an agent has something it can build.
  - A room outside a git repository says so in the invite banner instead of
    failing when someone types `/race`.
- Protocol 4: `propose` carries a lane count, `delta` and `toolResult` carry the
  lane they came from, and a `lanes` frame reports every attempt's state.

## 0.8.0

- **Four more coding CLIs**: `gemini`, `cursor` (`cursor-agent`), `aider` and
  `amp`, each a small profile over the shared process driver. Ten backends now,
  and `mpx share` detects any of them.
- **Rooms say when a backend cannot carry a session.** Only `claude-code`,
  `codex` and `opencode-json` report an id to resume; the plain-text CLIs start
  fresh every turn, and a room now says so instead of letting you assume
  otherwise.
- **`mpx rooms`** lists what a relay is hosting — names, seats and age, never a
  token. Opt in on the relay with `--directory`, since room names are metadata.
- Test concurrency is pinned. Twelve test files on four cores, one launching
  Chromium, would occasionally wedge the default fan-out — an intermittent hang
  that had been mistaken for slowness.

## 0.7.0

- **The Anthropic SDK is now optional.** It is 12MB and serves one backend —
  the only one wanting an API key rather than a subscription — but a static
  import made every install download it and put it in two thirds of the editor
  extension's bundle. It now loads on demand, is an optional peer dependency,
  and a missing install produces the command to fix it. The extension bundle
  fell from 799KB to 258KB, and the CLI's only runtime dependency is `ws`.
- **An editor seat.** A VS Code extension — working in **Cursor, VSCodium and
  Windsurf** too — that joins or hosts a room from the activity bar, with
  Approve and Veto on whatever is pending and the model's reply streaming in
  place. Not yet on a registry: build it with `npm run build:extension` and
  install the `.vsix`, or take the one CI attaches to each run. It targets
  Open VSX rather than the VS Code Marketplace, since Live Share is licensed
  to official Microsoft builds and blocked in forks.
- The extension host owns the connection and imports the same client, protocol
  and crypto the terminal uses, so an editor seat is the same code with a
  different view rather than a reimplementation.
- `sessionPage()` no longer resolves its own path at import time. Bundlers that
  emit CommonJS leave `import.meta.url` undefined, which threw and would have
  stopped the extension activating.

## 0.6.0

Sessions now cross the internet safely.

- **End-to-end encryption with forward secrecy.** Each connection agrees a key
  by ephemeral ECDH (P-256), authenticated with the room token and salted by
  both sides' nonces; traffic is sealed with AES-256-GCM under that key. The
  token authenticates the exchange but never encrypts anything, so a recording
  made today stays unreadable even if the link leaks tomorrow.
- **The token never travels.** It was previously sent as `?t=` in the
  WebSocket URL, which meant a relay operator learned the room's password.
  Authentication is now decryption: a seat proves it belongs by producing a
  frame the room can open.
- **TLS without a reverse proxy** — `--tls-cert` / `--tls-key` on both
  `mpx relay` and `mpx share`.
- **`mpx join` refuses plaintext to a public address** when a room has no token
  and therefore no encryption. Override with `--insecure`.
- A socket that connects without proving itself is dropped after ten seconds
  rather than held open.
- The browser seat encrypts too, via WebCrypto. Browsers only expose that in a
  secure context, so it needs `https` (or `localhost`) and says so plainly
  instead of downgrading.
- Protocol version 2. A v1 client cannot talk to a v2 room.

## 0.5.1

- Relicensed to **MIT**. The previous release shipped PolyForm Noncommercial;
  this drops the noncommercial restriction entirely, so commercial use needs no
  permission. Attribution is the only condition, and there is still no warranty
  or liability.

## 0.5.0

- Account pooling is now **experimental and opt-in** on both sides — `--pool` on
  the host, `--runner` on a seat. Without them, every turn runs on the host's
  account and the room says nothing about runners at all.
- `--help` is two tiers: the few lines almost everyone needs, and
  `mpx help --all` for the rest.
- Licensed under PolyForm Noncommercial 1.0.0 (superseded by MIT in 0.5.1).
- Full documentation under [`docs/`](./docs).

## 0.4.0

- Turns can run on other people's subscriptions. The room stays on one account
  while it works and hands the session over when one reports a usage limit,
  carrying the conversation across itself.
- `limits.ts` separates "this account is spent" from "this is broken", and reads
  a reset time out of the message when the tool gives one.
- Runners are listed with their own working directories, since tools act on the
  runner's checkout rather than the host's.

## 0.3.0

- `mpx share`: one command, auto-detected backend, and a link to send.
- A **browser seat** served at `/s/<room>` by the host or the relay — read,
  propose, vote and veto with nothing installed.
- The share token moved into the URL fragment, so it never reaches a server as
  part of an HTTP request.
- `mpx join` accepts the share link, the raw WebSocket URL, or a bare host:port.

## 0.2.0

- Backends for **Codex**, **GitHub Copilot CLI** and **OpenCode**, alongside
  Claude Code. Each is a small profile over a shared process driver.
- `--backend-bin` and `--backend-arg` to repair a drifted CLI from the command
  line.
- `--resume` and `--attach` to ride a session that already exists.
- **Relay**: the host dials out, so no inbound port is needed anywhere.

## 0.1.0

- First release. A room server owning one AI session, terminal seats over
  WebSockets, and a consent gate between the two.
- Six decision modes, six presets, lazy-consensus timers, veto with a recorded
  reason, amendments that clear votes.
- The model's tool calls go through the same gate.
- A JSONL audit log of every proposal, vote and veto, replayable with
  `mpx transcript`.
