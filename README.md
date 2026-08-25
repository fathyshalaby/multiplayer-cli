# multiplayer-cli

**Make your AI sessions multiplayer.**

One AI session. Several people in it. Nothing reaches the model until the room agrees.

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

---

## Install

```bash
npm install -g multiplayer-cli
```

Node 20.11+. Nobody needs an API key: the room runs on whatever coding CLI each
person is already logged into. You can also join from a browser with nothing
installed at all.

## The whole thing

```bash
mpx share
```

```
  amber-ridge-04   claude-code  ·  ~/work/api
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

`mpx share` picks whichever coding CLI you already have — Claude Code, Codex,
Copilot, OpenCode — and if you have none, it still runs on an offline demo
backend so you can see how a room works. `mpx backends` shows what it found.

The token lives in the link's fragment, which browsers never send to a server,
so it stays out of access logs. Treat the link like a password.

## How it works

```
   alice ─┐
   bob   ─┼──► room server ──► consent gate ──► the one AI session
   carol ─┘        ▲                 │
                   └── votes ────────┘
```

The host runs the room, and it decides *what* gets sent. Who *sends* it is a
separate question: any seat can offer its own machine and subscription, and the
room moves the session across when an account runs dry. See
[Whose subscription pays](#whose-subscription-pays).

**Typing is suggesting.** In a gated room, a line of text is a proposal, not a
message. It gets an id (`#4`), a tally, and usually a countdown.

**The room votes.** `/y` approves, `/n` rejects (with an optional reason that
becomes the recorded justification), `/amend` rewrites a proposal — which clears
the votes, because people approved the old wording, not the new one.

**The model's tool calls are voted on too.** When the assistant wants to run
`bash: rm -rf build/`, that becomes a proposal like any other and the turn
genuinely blocks until the room answers. Reads are auto-allowed by default;
writes and shell commands are not. A denial goes back to the model as a
decision, not an error, so it explains what it would have done instead.

**Side chat is free.** `/say let's ask it to compare the two first` reaches the
room and never touches the model or the context window.

**Everything is recorded.** Each session writes `.mpx/<room>.jsonl`: who
proposed what, who approved, who vetoed and why, what the model did. Replay it
with `mpx transcript`.

---

## Whose subscription pays

Everyone in the room already pays for something — Claude Max, ChatGPT Plus,
Copilot. The room runs on those, not on one person's API bill.

When you join, your seat offers your own machine and its logged-in CLI:

```
    ● alice   host
      claude-code ← running   4 turns
    ● bob
      codex ready
    ● carol
      claude-code (out of capacity)
```

The room stays on one account for as long as it can, because staying put is what
keeps a session coherent — the underlying tool resumes its own thread and keeps
its own cache. It moves only when an account says it is out of capacity:

```
  · alice's claude-code is out of capacity until 3:00:00 PM
  ⇄ the session moved to bob's codex
```

That is the thing this buys you. "Claude usage limit reached, resets at 3pm"
stops being the end of the afternoon and becomes a paragraph of handoff.

**Nobody shares credentials.** Every account runs only on the machine it is
logged in on. A turn that runs on bob's subscription runs on bob's laptop,
under bob's login, on a prompt bob's room approved — mpx never sees, moves, or
asks for anyone's token.

Two things to know before you rely on it:

- **A handoff is a summary, not a transplant.** The room owns the only complete
  record of the session, so it carries that across — but the new tool has none
  of the previous one's tool results or file state, and the recap tells it so
  explicitly rather than letting it assume otherwise.
- **Tools act on the runner's own checkout.** The shared object is the session,
  not the filesystem. When a turn runs on bob's machine it reads and writes
  bob's copy of the repo. Each runner's working directory is shown in `/who`
  and `/status`, so this is visible rather than surprising.

Opt out per seat with `--no-runner`, and the room falls back to the host's
account. Pick which of your CLIs to offer with `--backend`, and where it runs
with `--cwd`.

Only a *capacity* failure hands off. A plain bug fails once and is reported —
burning through everyone's account to prove the same error four times helps
nobody.

## Decision policies

The gate is the interesting part, so it is configurable rather than opinionated.

```bash
mpx policies
```

| Preset | Prompts | Tools | Good for |
|---|---|---|---|
| `solo` | open | open | a shared screen with no ceremony |
| `pair` | everyone consents, 20s timer, any veto stops it | consensus | two or three people |
| `team` *(default)* | majority + veto, 45s timer | majority + veto | a working group |
| `strict` | unanimous, no timers, no auto-yes | unanimous | production, or an audience you don't know |
| `host` | the host decides | the host decides | demos and workshops |
| `round-robin` | only whoever holds the mic | majority | structured sessions |

Modes: `open`, `owner`, `majority`, `quorum`, `consensus`, `round-robin`.

The timer is **lazy consensus** — when it expires with no objection, the
proposal ships. Set `minYes` if you want silence to mean "not yet" instead:

```bash
mpx share --policy team --set mode=quorum --set quorum=3 --set timeout=90s
mpx share --policy strict --set tool.mode=owner --set autoAllow=read,write
mpx share --policy pair --set timeout=off        # nothing moves without a vote
```

Change it mid-session (host only):

```
/policy strict
/policy mode=consensus timeout=30s
```

Every policy key: `mode`, `quorum`, `veto`, `timeout`, `minYes`,
`proposerAutoYes`, `soloBypass`, the same set again under `tool.`, plus
`autoAllow`, `interrupt`, `merge`, `attribute`.

---

## Commands

Anything that isn't a command becomes a proposal.

| | |
|---|---|
| `/y [#id]` | approve — defaults to the newest open proposal |
| `/n [#id] [reason]` | reject; with veto on, this alone stops it |
| `/abstain [#id]` | no opinion, so the room stops waiting on you |
| `/amend [#id] <text>` | rewrite a pending proposal (clears its votes) |
| `/withdraw [#id]` | take back your own proposal |
| `/say <text>` | talk to the room without spending a turn |
| `/stop` | interrupt the running turn (also `Ctrl-C`) |
| `/queue` `/who` `/status` | what's pending, who's here, what's going on |
| `/policy` | show or change the decision rules |
| `/mic <name>` | hand over the mic in round-robin mode |
| `/me <name>` | change your display name |

---

## Getting teammates in

`mpx share` binds to your local network, so anyone on the same wifi or VPN can
open the link. Three ways to change that:

```bash
mpx share --local            # this machine only
mpx share --relay wss://…    # reachable anywhere — remembered from then on
mpx share --open             # no token; anyone who can reach it may join
```

A relay is any box your team can reach — a small VPS is plenty:

```bash
mpx relay --port 7788        # once, on that box
mpx share --relay wss://relay.example.com
```

The host dials *out* to it, so there is nothing to open or forward on your side.
The relay is a dumb pipe: it never receives the room token and cannot admit
anyone the host would refuse — every seat still passes the host's own check
end-to-end through it, and every vote is still counted by the host. What it
*can* see is session content in the clear, so run your own and put TLS in front
(`mpx relay` speaks plain `ws://`; terminate with Caddy or nginx). It caps
rooms, seats per room, and join attempts per minute.

An SSH tunnel still works too, if you would rather run nothing:

```bash
ssh -R 7777:localhost:7777 you@jumpbox
```

Read-only seats:

```bash
mpx join <url> --observer     # sees everything, cannot propose or vote
```

---

## Backends

Bring whichever coding CLI your team already uses. The room's job is the same in
every case: nothing gets sent until the group agrees.

| `--backend` | Session model | Streaming | Room votes on tool calls |
|---|---|---|---|
| `anthropic` *(default)* | Claude conversation owned by the room | per-token | **yes** |
| `claude-code` | one long-lived `claude` process | per-token | no — Claude Code's own permissions |
| `codex` | `codex exec --json`, resuming the thread each turn | per item | no — Codex's sandbox/approval modes |
| `copilot` | `copilot -p`, resuming the session each turn | raw stdout | no — `--allow-tool` / `--deny-tool` |
| `opencode` | `opencode run`, resuming the session each turn | raw stdout | no — OpenCode's own permissions |
| `opencode-json` | same, with `--format json` for structured events | per event | no |
| `echo` | offline stand-in, no key and no spend | per-token | **yes** |

`mpx backends` prints this with the details.

**One honest limitation.** Every backend gates what the room *sends*. Only
`anthropic` and `echo` also put the model's own tool calls to a vote, because
those are the two where mpx owns the agent loop and can pause between
`tool_use` and execution. The other CLIs run their own loops and never ask us,
so their own permission systems apply — pair them with `--permission-mode`,
`--allow-tool`, `--sandbox` and friends via `--backend-arg`.

### These CLIs move fast

Flags change between releases. Two escape hatches mean a drifted tool is a
command-line fix, not a version bump here:

```bash
mpx share --backend codex --backend-bin /opt/bin/codex          --backend-arg --sandbox --backend-arg workspace-write
```

`--backend-bin` picks the binary; `--backend-arg` is repeatable and appended
verbatim, last, so it overrides what the profile built.

### Riding a session that is already shared

Some of these tools have their own sharing, and where they do, mpx can sit on
top of it rather than compete with it.

```bash
# OpenCode's server already accepts several clients on one session.
opencode serve --port 4096
mpx share --backend opencode --attach http://localhost:4096

# Continue a session that already exists, in any backend that has one.
mpx share --backend claude-code --resume 8f3a…
mpx share --backend codex       --resume th_abc123
```

`--resume` takes whatever that tool calls a session or thread id; mpx captures
the id from the first turn and reuses it for every turn after, so a room really
is one conversation rather than a series of unrelated ones.

## Transcripts

```bash
mpx transcript .mpx/amber-ridge-04.jsonl           # full replay
mpx transcript .mpx/amber-ridge-04.jsonl --votes   # just the decisions
```

```
20:51:00 ▸ alice #1: add retry logic to the http client
20:51:03 ✓ #1 approved — 2/2 approvals
20:51:04 │ Here's a backoff wrapper around the client…
20:51:08 ▸ alice #2: now delete the production database
20:51:08 ✗ #2 rejected — vetoed: that is too destructive
```

Disable with `--no-transcript`.

---

## Use it from inside Claude Code

The repo ships a skill, so you can just ask:

```bash
cp -r skills/multiplayer ~/.claude/skills/
```

> *"share this session with my team"* — or `/multiplayer`

It starts the room and hands you the link to paste.

## Commands

| | |
|---|---|
| `mpx share` | start a room and print a link to send |
| `mpx join <link>` | take a seat, and offer your own subscription to the room |
| `mpx relay` | run a relay, so hosts need no open port |
| `mpx serve` | run a room with no local seat |
| `mpx backends` | which AI CLIs you can use, and which are installed |
| `mpx policies` | how the room can decide things |
| `mpx transcript <file>` | replay a session's audit log |

`mpx host` is `mpx share` without the opinionated defaults — bind to localhost,
no auto-detected backend, explicit flags only.

---

## Development

```bash
npm install
npm run build
npm test          # 136 tests: gate logic, room rules, CLI adapters, relay,
                  # share links, subscription failover, and the browser seat
                  # driven in real Chromium
```

The layout follows the seams:

```
src/protocol.ts       the wire contract
src/core/gate.ts      the consent decision — pure, no clock of its own
src/core/room.ts      participants, proposals, timers, queue
src/core/policy.ts    presets and overrides
src/server/transport  how seats arrive: a local port, or a relay dialled out to
src/server/relay.ts   the relay itself — a pipe that knows as little as possible
src/server/server.ts  the room, wired to the session
src/agent/profiles.ts one small profile per coding CLI: argv in, room events out
src/agent/process.ts  the shared process driver those profiles plug into
src/agent/limits.ts   telling "this account is spent" from "this is broken"
src/server/runners.ts routing turns across accounts, and the handoff between them
src/client/runner.ts  offering this machine's own logged-in CLI to the room
src/client/           connection, commands, terminal UI
src/client/web/       the browser seat — one self-contained page, no build step
```

Adding a CLI is a profile, not a class: build an argv, say whether output is
JSONL or text, and map that tool's events onto the room's. The adapters are
tested against stub binaries that emit exactly what each tool documents, so
flag construction and event mapping are covered without the tool installed.

`gate.ts` is deliberately pure: same inputs, same verdict, with `now` passed in.
Every voting rule in the table above is a unit test.

## License

MIT
