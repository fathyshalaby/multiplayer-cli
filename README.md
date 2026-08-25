# multiplayer-cli

**Make your AI session multiplayer.**

One AI session. Several people in it. Nothing reaches the model until the room
agrees.

<p align="center">
  <img src="./docs/media/session.svg" alt="A recorded multiplayer-cli session: alice proposes a change, bob vetoes it with a reason, and the room talks it over." width="720">
</p>

Pair programming with an AI is usually one person driving and everyone else
reading over a shoulder — or worse, three people running three private sessions
that each learn a third of the context. `mpx` makes the session itself the
shared object: everyone sees the same transcript, everyone can propose, and the
room decides together what actually gets sent.

Works with **Claude Code**, **Codex**, **Copilot CLI**, **OpenCode**, **Gemini**,
**Cursor**, **Aider** and **Amp** — whichever you are already signed into.

---

## Install

```bash
npm install -g multiplayer-cli
```

Node 20.11+, and one dependency. No API key needed — the room runs on whatever
coding CLI you are already logged into. Everyone else joins with `mpx`, or from
a browser with nothing installed at all.

## The whole thing

```bash
mpx share
```

```
  amber-ridge-04   claude-code  ·  ~/work/api
  found `claude` on your PATH
  prompts: majority+veto 45s   tools: claude-code's own permissions

  Send this to your team:

    http://192.168.1.20:7777/s/amber-ridge-04#t=Kf3nQ8vLm2

    Opening it gives them a seat in the browser, or the command to join from a terminal.
```

Paste the link in chat. Whoever clicks it lands on a page offering two ways in —
a seat right there in the browser, or the one-line command for a terminal:

```bash
npx multiplayer-cli join ws://192.168.1.20:7777/r/amber-ridge-04?t=Kf3nQ8vLm2
```

Then type to propose, `/y` to agree. That is the whole interface.

No coding CLI installed? `mpx share` still runs, on an offline demo backend, so
you can see how a room works before anything is real.

---

## How it works

```
   alice ─┐
   bob   ─┼──► room server ──► consent gate ──► the one AI session
   carol ─┘        ▲                 │
                   └── votes ────────┘
```

The host runs the room. Participants are thin seats: they never talk to the
model, they propose and vote, and the room streams one response to everyone.
Every turn runs on the host's account, on the host's machine.

**Typing is suggesting.** In a gated room a line of text is a proposal, not a
message. It gets an id (`#4`), a tally, and usually a countdown.

**The room votes.** `/y` approves, `/n` rejects — with an optional reason that
becomes the recorded justification — and `/amend` rewrites a proposal, which
clears its votes, because people approved the old wording.

**The model's tool calls are voted on too.** When the assistant wants to run
`bash: rm -rf build/`, that becomes a proposal like any other and the turn
genuinely blocks until the room answers. A denial goes back to the model as a
decision, not an error. *(On backends where mpx owns the agent loop — see
[Backends](./docs/backends.md).)*

**Side chat is free.** `/say let's ask it to compare the two first` reaches the
room and never touches the model or the context window.

**Everything is recorded.** Each session writes `.mpx/<room>.jsonl`: who
proposed what, who approved, who vetoed and why. Replay it with
`mpx transcript`.

**Traffic is end-to-end encrypted, with forward secrecy.** The token in the
share link authenticates an ephemeral key exchange rather than being the key, so
a relay or proxy in the path moves ciphertext it cannot read — and a recording
made today stays unreadable even if the link leaks tomorrow. The token itself
never goes on the wire. See [Security model](./docs/security.md).

---

## Documentation

| | |
|---|---|
| [Getting started](./docs/getting-started.md) | install, share, join, and the commands in a session |
| [The terminal seat](./docs/the-screen.md) | the full-screen panes, the keys, and when it uses one column |
| [Deciding together](./docs/deciding.md) | the voting rules, presets, and how to tune them |
| [Backends](./docs/backends.md) | which AI CLI runs the session, and adding another |
| [Reaching your team](./docs/relay.md) | LAN, relays, tunnels |
| [Security model](./docs/security.md) | what the token protects, and what it does not |
| [Racing](./docs/racing.md) | trying one prompt several ways at once, and voting on the diff |
| [Crossroads](./docs/crossroads.md) | when the agent stops at a fork and asks the room which way |
| [Account pooling](./docs/pooling.md) | spreading turns across accounts — experimental |
| [The editor seat](./docs/editor.md) | the VS Code / Cursor extension |
| [Protocol](./docs/protocol.md) | the wire format, for building your own client |

## Commands

| | |
|---|---|
| `mpx share` | start a room and print a link to send |
| `mpx join <link>` | take a seat — the share link or the `ws://` URL both work |
| `mpx relay` | run a relay, so hosts need no open port |
| `mpx rooms` | what a relay is hosting — names only |
| `mpx serve` | run a room with no seat of your own |
| `mpx backends` | which AI CLIs you can use, and which are installed |
| `mpx policies` | how the room can decide things |
| `mpx transcript <file>` | replay a session's audit log |

`mpx help --all` lists every option. `mpx host` is `mpx share` without the
opinionated defaults.

## Decision presets

| Preset | Prompts | Good for |
|---|---|---|
| `solo` | open | a shared screen with no ceremony |
| `pair` | everyone consents, 20s timer, any veto stops it | two or three people |
| `team` *(default)* | majority + veto, 45s timer | a working group |
| `strict` | unanimous, no timers | production, or an audience you don't know |
| `host` | the host decides | demos and workshops |
| `round-robin` | only whoever holds the mic | structured sessions |

```bash
mpx share --policy strict
mpx share --policy team --set mode=quorum --set quorum=3 --set timeout=90s
```

Details in [Deciding together](./docs/deciding.md).

## Try it three ways at once

A vote decides whether to send a prompt. It cannot tell you whether the answer
was any good — nobody knows that until somebody tries.

```
/race 3 make the retry logic exponential
```

The room runs the prompt three times in parallel, each agent in its own git
worktree on its own branch. When they finish, everyone sees a diff per lane and
votes on which one lands:

```
  ✓ A  3 files +64 -12        ⚑ #4 land lane A
  ·  B  finished without changing anything
  ✓ C  1 file +8 -3           ⚑ #5 land lane C
```

Approving one merges it into your checkout. The branches nobody took are kept,
not deleted. Voting all of them down is a legitimate answer too — you found out
that none of the three approaches was right, in the time it took to try one.

Needs a git repository; `mpx share --lanes 0` turns it off. Details in
[Racing](./docs/racing.md).

## Let the agent ask

Every gate above is the room interrupting the agent. This is the other
direction: the agent hits a real fork and stops to ask which way, *before*
spending the work.

```
  ⑂ codex asks the room to pick a direction
    Should the v1 API keep working after this change?

    ⑂ #2 a — Shim it      keep v1 alive behind an adapter
    ⑂ #3 b — Migrate      drop v1 and update every caller
```

Racing answers "which approach?" by building all of them. This answers it by
asking — which is the only thing that works when the fork is about intent
rather than code. *"Must v1 keep working?"* is a decision, not a fact; no
amount of running the code settles it.

Any backend can raise one, and anyone can raise one by hand with `/ask`. There
is no timer: silence can approve a message, but it cannot pick a direction.
Details in [Crossroads](./docs/crossroads.md).

## Use it from your editor

There is an extension for **VS Code, Cursor, VSCodium and Windsurf** — the same
seat, in a panel, with Approve and Veto on what is pending.

```bash
npm run build:extension
cd extension && npx vsce package --no-dependencies --out multiplayer-cli.vsix
cursor --install-extension multiplayer-cli.vsix   # or code / codium
```

It targets Open VSX rather than the VS Code Marketplace: Live Share is licensed
to official Microsoft builds and blocked in forks, so Cursor has had no
equivalent. See [The editor seat](./docs/editor.md).

## Use it from inside Claude Code

```bash
cp -r skills/multiplayer ~/.claude/skills/
```

> *"share this session with my team"* — or `/multiplayer`

It starts the room and hands you the link to paste.

---

## Development

```bash
npm install
npm run build
npm test          # 192 tests, no API key and no coding CLI required
```

The layout follows the seams:

```
src/protocol.ts       the wire contract
src/core/crypto.ts    the sealed frames everything else travels in
src/core/gate.ts      the consent decision — pure, no clock of its own
src/core/room.ts      participants, proposals, timers, queue
src/server/transport  how seats arrive: a local port, or a relay dialled out to
src/server/relay.ts   the relay — a pipe that knows as little as possible
src/agent/profiles.ts one small profile per coding CLI: argv in, room events out
src/client/web/       the browser seat — one self-contained page, no build step
src/client/roomView   what a graphical seat draws, editor-free so it is testable
extension/            the VS Code / Cursor seat: glue around that view model
```

`gate.ts` is deliberately pure: same inputs, same verdict, with `now` passed in.
Every voting rule is a unit test. CLI adapters are tested against stub binaries
that emit exactly what each tool documents, and the browser seat is driven in a
real Chromium.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Licence

[MIT](./LICENSE) — use it, change it, ship it, sell it. Attribution is the only
condition, and there is no warranty or liability.
