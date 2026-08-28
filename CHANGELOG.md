# Changelog

## Unreleased

### Security

- **The relay accepted a 100 MiB frame from anyone who could connect.** Neither
  WebSocket server set `maxPayload`, so both took the library default — four
  orders of magnitude more than a room frame, which is sealed JSON measured in
  kilobytes. The relay buffers each frame and stringifies it to forward, and at
  the default limits it accepts 64 rooms of 32 seats, so the memory a stranger
  could make it spend was bounded only by how many sockets they opened. It is
  the one component the docs suggest running on a small box for other people.
  Both the relay and a direct room's listener now cap frames at 8 MiB, and the
  relay takes `--max-frame` alongside its other limits.

- **The tool gate did not follow a turn onto a pooled runner.** On `anthropic`
  and `echo` the room votes on the model's tool calls, because those are the
  two backends where mpx owns the agent loop. A runner runs that loop on its
  own machine and approved every tool call locally, so a turn routed there
  executed commands the same turn would have had to put to the room at home.
  A `strict` room — where nothing is auto-allowed and every command is meant to
  need unanimity — was quietly getting something weaker than it asked for, and
  `security.md` said otherwise.

  For a CLI backend there is nothing to fix: `codex` and the rest run their own
  agent loops and permission systems, and the room never saw those tool calls
  to vote on. Closing it for the other two means carrying each approval back
  over the socket and holding the turn until the room answers — a protocol
  change, and one that needs an answer for a runner that drops mid-vote. So for
  now it is announced rather than silent: the room is told when such a runner
  joins, the runner is told on its own machine, and both docs say plainly that
  the gate describes turns the room runs itself.

- **The transcript was world-readable.** `.mpx/<room>.jsonl` is the room in
  plain text — every proposal, every veto reason, the chat, and everything the
  model said, which includes whatever it read out of the repository. It was
  written at the umask default, so on a dev box, a build agent or a shared jump
  host every other account could read every session. It is `0600` in a `0700`
  directory now. Old transcripts on a shared machine want a `chmod 600`.
- **The link can now come from the environment.** `mpx join <link>` puts the
  room's key in `argv`, where any other account can read it out of `ps`, and in
  your shell history afterwards. The token is kept off the wire with real care,
  so leaving it in the process table was the wrong end to be careless at.
  `MPX_LINK=… mpx join` avoids both. The argument still wins when both are
  given, so nothing that works today stops working, and `security.md` now says
  plainly that a link on a command line is exposed.

- **Tool paths could escape the working directory through a symlink.**
  `safePath` was a lexical check — `resolve` then `relative` — while its own
  comment claimed "symlinks included". `resolve` does not follow links, so
  `sub/link/id_rsa` contained no `..`, was not absolute, and passed; both
  `read_file` and `write_file` then followed it anywhere on disk. The
  `search` walker had the same hole by another door, since a symlink is not a
  directory and fell through to be read.

  This mattered more than a containment bug usually does: `read` is
  auto-allowed in every preset except `strict`, so the escape was not gated by
  a vote — in a tool whose entire claim is that the room agrees first. And
  repositories containing a link out of themselves are ordinary: monorepo
  package links, a checkout with a link to `$HOME`, fixtures pointing at
  shared data.

  Both sides are resolved now and re-checked, keeping the unresolved tail so
  `write_file` can still name a file that does not exist yet, and resolving the
  room's own cwd too so a room hosted under a symlinked path (`/tmp`, on macOS)
  still works. Proven against a real symlink before and after.
- **The editor panel escaped `<` and `>` but not quotes**, and put the result
  inside double-quoted attributes — so a value containing `"` closed the
  attribute and the rest parsed as markup, under a CSP that allows inline
  script. Reaching it needs a hostile or compromised room server, which the
  threat model already grants a great deal, but script execution in the
  victim's editor webview is past what that model concedes. The browser seat's
  escaper had always covered quotes; the two seats disagreed about what was
  safe, which is the drift the house rule about keeping seats level exists to
  catch.

Both are regression-tested, and each test was confirmed to fail with its fix
reverted.

- **The invite screen rendered the empty room underneath itself.** `header` sets
  `display: flex`, which beats the browser's own `[hidden] { display: none }`, so
  the room chrome showed through the invite complete with a placeholder dash —
  on the first thing every invited person sees.
- **The invite screen did not fit a phone.** `.gate` is a flex item, and the
  `auto` side margins centring it also cancel the default cross-axis stretch, so
  it took its 620px max-width whatever the viewport was and a 390px screen lost
  the right-hand third of every line. Most invites are opened on a phone, since
  the link was pasted into chat. Both are now regression-tested, and both tests
  were confirmed to fail with the fix removed.
- **A room that cannot offer a browser seat now says so before you commit.** On a
  LAN address over plain http there is no secure context, so the browser never
  exposes the encryption a room needs — but the check ran inside the join
  handler, so you typed your name, pressed the button, and only then were told.
  It runs on load now: the button is disabled, the heading stops promising a
  seat, and the terminal command below it is the one path that works.

- **A guide for the people who did not start the session.** Every page was
  written for the host, but most people in a room are the ones who were sent a
  link — and plenty of them are not programmers.
  [Someone sent you a link](./docs/joining.md) assumes nothing technical: what
  this is, click the link, type your name, what the buttons do, and the
  questions people actually ask — does it cost me anything, can I break
  something, can everyone see what I type.
- **The join page led with a shell command.** Anyone opening an invite met "in
  your terminal — the full experience" first, and the button they could actually
  use second. For the non-technical half of a room that is asking them to scroll
  past something they cannot use. The browser seat is now the headline and the
  terminal command is the alternative.
- The docs index, the README and the landing page all open by asking who you
  are and pointing invited people somewhere that assumes nothing.

- **The install command did not work.** `npm install -g multiplayer-cli` was the
  first line of the README, of getting-started, of the skill, of both Gemini
  commands — and of the join command the browser seat tells a teammate to copy.
  The package has never been published, so every one of them 404s. The landing
  page was fixed for exactly this in 0.12.0 and nothing else was. Everywhere now
  leads with `npx github:fathyshalaby/multiplayer-cli`, which runs today, and
  names the npm form as the one that will work once it is published.
- **A documentation index, with a glossary.** `docs/` was thirteen files in a
  flat list, and understanding a room meant holding room, seat, gate, proposal,
  lane, crossroads, relay and runner in your head before page two.
  [`docs/README.md`](./docs/README.md) defines the six words that carry most of
  it, orders the pages into a path, and answers the questions people actually
  arrive with — does everyone need a key, does everyone need to install it, what
  does it cost to try.
- **Every doc rewritten plainer.** Summary tables up top, the reference material
  kept, and the longer asides moved below the part you need. `getting-started`
  is numbered steps and now shows the five commands that cover a session instead
  of all twenty-two, with the full list behind a fold. `relay` opens with a table
  that picks the option for you. `security` opens with a six-row summary of what
  is and is not protected. Every page links back to the index instead of being a
  dead end.
- **The README and the landing page lead with the plain version.** What it is,
  who runs what, and what it costs to try — before any of the vocabulary. The
  landing page gains a three-step strip under the recording.
- The lockfile version is checked. It said 0.11.3 while the manifest said
  0.12.0, which `npm ci` does not catch and `npm install` silently corrects, so
  it survived a whole release. `npm run sync -- --check` now reports it.
- `CLAUDE.md` documents the repository for AI assistants: the module map, what a
  turn does end to end, the conventions that are load-bearing, and what each
  test file covers.
- The README said 192 tests. There are 302.

## 0.12.0

- **It installs into the agent CLIs, not just beside them.** The repository is
  now a Claude Code plugin marketplace (`/plugin marketplace add
  fathyshalaby/multiplayer-cli`) and a Gemini CLI extension
  (`gemini extensions install …`, which adds `/share` and `/join`). Both are the
  same skill in different packaging — it is a CLI, so the useful thing is an
  agent knowing when to reach for it and how to hand over the link without
  mangling the key in the fragment.
- **The skill had drifted like everything else.** It named five backends of
  eleven and knew nothing about racing, splitting, previews or crossroads —
  including the one feature where the agent is the actor rather than the room.
  Fixed, and now checked: every backend the CLI has must be named in the skill,
  and the features must appear *after* the link rather than before it, because
  an agent reads it top to bottom and repeats what it met first.
- **One copy, generated.** `scripts/sync-integrations.mjs` makes Gemini's
  context file from the skill and takes every version from `package.json`;
  `npm run sync -- --check` runs in CI, so a stale copy fails the build instead
  of shipping. This is the third time the same number in two files has caused a
  bug — `mpx --version` lied for two releases, the extension offered seven
  backends of eleven, and the skill named five.
- **The browser and editor seats had fallen behind the terminal.** `/split`
  answered `unknown command` in both, lane previews were not shown at all, and
  there was no `/help` whatsoever — a browser seat had no way to find out what
  it could do. All three are fixed, and a preview is a clickable link there
  rather than a URL to copy, since a browser seat is the one place that can
  just open the thing being voted on.
- **The extension offered seven of the eleven backends.** `gemini`, `cursor`,
  `aider` and `amp` were missing, and its version had drifted to 0.7.0 while
  the CLI was at 0.12.0. Both are now checked by tests: every backend the CLI
  has must be offerable from the editor, every policy the editor offers must be
  a real preset, and the two versions must match. `engines.vscode` is asserted
  to stay at or below 1.90 so a creeping floor cannot quietly make the
  extension uninstallable in Cursor, Windsurf and VSCodium.
- The editor exposes the preview settings too: `multiplayer.lanePreview`,
  `lanePreviewPort` and `lanePreviewHost`, with defaults asserted to match the
  CLI's.
- **A bare `/help` shows the eight commands you need, not all twenty-two.**
  Agreeing, disagreeing, talking, stopping, and seeing who is here is the whole
  job; the feature list answers a question nobody a minute into their first room
  is asking, and buries the ones they are. `/help all` still shows everything,
  and names what is in there so nobody concludes there is no rest. Aliases are
  held back too — four ways to say yes is a kindness once you are using the
  thing and noise while you are learning what it does.
- **The invite banner no longer advertises racing.** `mpx share` has one job,
  which is handing over a link, and every extra line competed with it. Racing,
  splitting and lanes are in `/help all` and the docs, for the moment there is a
  reason to want them. The caveat about lanes not seeing uncommitted work now
  appears when someone actually starts a race, which is when it means anything.
- **`/split` runs different work in parallel lanes, each landing on its own.**
  `/race` opens several lanes on one prompt and the room takes one of them;
  `/split a | b` opens one lane per prompt and the room can take all of them.
  The difference is what the lanes are to each other — a race's are substitutes,
  a split's are complements, and "which is better, the frontend or the backend"
  is a malformed question rather than a hard one. Approving one lane of a split
  withdraws nothing, and the split ends once every lane has been decided.
  Merges queue rather than run at once, because two `git merge` calls in one
  checkout is a corrupted index.
- **A split says when two lanes claimed the same file.** Either two agents did
  the same work twice, or there is a merge conflict the room has not met yet.
  It is a warning and never a veto: a route and its test touching one file is
  normal, and a tool that refuses on a heuristic is one people route around. A
  race stays quiet, because its lanes are meant to overlap.
- **Lanes can be looked at, not just read.** `--lane-preview "<cmd>"` starts
  each finished lane on its own port, so the room votes on the running thing
  rather than on a diffstat. `{port}` is substituted into the command and
  `PORT` is set in the environment; ports are probed before they are handed
  out, so two lanes in the same race never collide. A preview that will not
  start is reported on its lane and costs it nothing — the diff is still there
  and the room can still vote on it. Off by default: three lanes is three dev
  servers, and most work has nothing to look at.
- Previews are stopped before their worktrees are removed, and stopping one
  kills the whole process group. `npm run dev` is a shell that spawns a server:
  killing the shell alone leaves the server running, reparented to init, still
  holding the port. The group is swept and the sweep waits for the kernel to
  finish, so the next race can have the port back.
- A preview can never keep `mpx` from exiting. It is detached and its pipes are
  unref'd, so even a stray one is the operating system's problem rather than
  the room's.

## 0.11.3

- **A captured handshake frame could hold a socket open indefinitely.**
  Finishing the key agreement was treated as proof that a peer belonged, but
  the client's half is a MAC over its own public key and nonce — nothing in it
  is chosen by the connection it arrives on, so an opening frame observed on
  the wire replays perfectly. The replayer can never say anything (it has no
  private half), but it could keep a connection slot for as long as it liked,
  and repeat that until a room was full. The clock now stops only when a frame
  arrives that decrypts, which a real seat produces in milliseconds.
- **Shutting a room down left unauthenticated sockets attached.** Only seats
  that had said `hello` were closed, so a connection still handshaking — or
  refusing to speak — survived `close()` and kept the process alive with it.

## 0.11.2

- **The published extension was two thirds waste.** With no `.vscodeignore`,
  `vsce` packaged the TypeScript source, the build config, the integration
  tests and a 602KB source map — none of it reachable at runtime. 231KB and 13
  files becomes 85KB and 8.
- CI checks the packaged `.vsix` itself, not just the extension running from
  source. Activating from source proves the extension works; it says nothing
  about what gets published, which is how a missing runtime file or a shipped
  test would reach a user unnoticed.

## 0.11.1

- **The demo now opens on the product.** It led with the invite banner — six
  lines of setup caveats, a scratch path and a localhost URL — and put the
  voting below the fold of its own terminal. The recorder clears the screen
  first, and the renderer treats a screen wipe as the point the recording
  starts, so the first frame is the fork with two people deciding it.
- **A recording for phones.** The 118-column one scaled to a 350px screen was
  an unreadable smear, which is most of the opens for a link people paste into
  chat. There is a 66-column recording now, which is what a narrow terminal
  genuinely renders — the seat drops its sidebar under 84 columns — and the
  page picks between them.
- The landing page shows the four gates as a 2x2 rather than 3+1, which had
  orphaned crossroads under a heading whose whole point is that it is the
  fourth one.
- The install line is `npx github:fathyshalaby/multiplayer-cli`, which works
  today. `npx multiplayer-cli` will not until the package is published, and a
  landing page whose first command 404s is worse than a long one that runs.

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
