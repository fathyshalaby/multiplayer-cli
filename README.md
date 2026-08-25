# multiplayer-cli

**Make your AI session multiplayer.**

One AI session. Several people in it. Nothing reaches the model until the room
agrees.

```
  ▸ alice proposes #4
      rewrite the auth middleware to use short-lived JWTs
      [2/3 ✓ · 1 pending · 18s left]  ✓alice ✓bob   /y #4  /n #4  /amend #4 …

  ✗ #4 rejected  — vetoed: we agreed to keep sessions server-side

  💬 carol: let's ask it to compare the two first
```

Pair programming with an AI is usually one person driving and everyone else
reading over a shoulder — or worse, three people running three private sessions
that each learn a third of the context. `mpx` makes the session itself the
shared object: everyone sees the same transcript, everyone can propose, and the
room decides together what actually gets sent.

Works with **Claude Code**, **Codex**, **GitHub Copilot CLI** and **OpenCode**.

> Free for noncommercial use. Commercial use needs the licensor's permission —
> see [Licence](#licence).

---

## Install

```bash
npm install -g multiplayer-cli
```

Node 20.11+. No API key needed — the room runs on whatever coding CLI you are
already logged into. Everyone else joins with `mpx`, or from a browser with
nothing installed at all.

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

---

## Documentation

| | |
|---|---|
| [Getting started](./docs/getting-started.md) | install, share, join, and the commands in a session |
| [Deciding together](./docs/deciding.md) | the voting rules, presets, and how to tune them |
| [Backends](./docs/backends.md) | which AI CLI runs the session, and adding another |
| [Reaching your team](./docs/relay.md) | LAN, relays, tunnels |
| [Security model](./docs/security.md) | what the token protects, and what it does not |
| [Account pooling](./docs/pooling.md) | spreading turns across accounts — experimental |
| [Protocol](./docs/protocol.md) | the wire format, for building your own client |

## Commands

| | |
|---|---|
| `mpx share` | start a room and print a link to send |
| `mpx join <link>` | take a seat — the share link or the `ws://` URL both work |
| `mpx relay` | run a relay, so hosts need no open port |
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
npm test          # 137 tests, no API key and no coding CLI required
```

The layout follows the seams:

```
src/protocol.ts       the wire contract
src/core/gate.ts      the consent decision — pure, no clock of its own
src/core/room.ts      participants, proposals, timers, queue
src/server/transport  how seats arrive: a local port, or a relay dialled out to
src/server/relay.ts   the relay — a pipe that knows as little as possible
src/agent/profiles.ts one small profile per coding CLI: argv in, room events out
src/client/web/       the browser seat — one self-contained page, no build step
```

`gate.ts` is deliberately pure: same inputs, same verdict, with `now` passed in.
Every voting rule is a unit test. CLI adapters are tested against stub binaries
that emit exactly what each tool documents, and the browser seat is driven in a
real Chromium.

See [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Licence

**[PolyForm Noncommercial 1.0.0](./LICENSE)** — free to use, modify and share
for any noncommercial purpose, including personal projects, research, education,
charities and government.

**Commercial use requires the licensor's written permission.** That includes
internal use at a for-profit company, use in a paid product or service, and
consulting delivered for a fee. Requests are welcome — open an issue.

The software comes as is, with no warranty and no liability, as far as the law
allows.

> This makes multiplayer-cli *source-available*, not open source: the OSI
> definition does not allow restricting commercial use. Nothing here is legal
> advice.
