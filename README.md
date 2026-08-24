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

Requires Node 20.11+. Only the **host** needs model credentials; everyone else
just needs to reach the host's port.

## Two minutes to a shared session

Try the whole thing with no API key at all:

```bash
mpx host --backend echo --policy pair
```

It prints an invite:

```
  invite your team:
    mpx join ws://127.0.0.1:7777/?t=Kf3nQ…
```

Open a second terminal, paste that command, and you have a two-seat room. Type a
sentence in one; watch it appear as a *proposal* in the other; approve it with
`/y` and watch the reply stream to both.

For real work, point it at whichever CLI your team already uses:

```bash
mpx host                                # Claude via the API (default)
mpx host --backend claude-code          # share an actual Claude Code session
mpx host --backend codex                # OpenAI Codex
mpx host --backend copilot              # GitHub Copilot CLI
mpx host --backend opencode             # OpenCode
```

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
Only the host needs credentials, and only the host needs the coding CLI
installed — the rest of the team just needs `mpx`.

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
mpx host --policy team --set mode=quorum --set quorum=3 --set timeout=90s
mpx host --policy strict --set tool.mode=owner --set autoAllow=read,write
mpx host --policy pair --set timeout=off        # nothing moves without a vote
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

The host binds to `127.0.0.1` and requires a token by default.

**Same machine** — just run the printed `mpx join` command.

**Same network** — `mpx host --host 0.0.0.0`, then share the LAN invite it prints.

**Anywhere, no inbound port** — run a relay and dial out to it:

```bash
# once, on any box your team can reach (a small VPS is plenty)
mpx relay --port 7788

# then, on the host — nothing to open, nothing to forward
mpx host --relay wss://relay.example.com
#   invite your team:
#     mpx join wss://relay.example.com/r/amber-ridge-04?t=Kf3nQ…
```

The relay is a dumb pipe. It never receives the room token and cannot admit
anyone the host would refuse — every seat still has to pass the host's own check
end-to-end through it, and every vote is still counted by the host. What it
*can* see is session content in the clear, so run your own and put TLS in front
of it (`mpx relay` speaks plain `ws://`; terminate TLS with Caddy or nginx).
It caps rooms, seats per room, and join attempts per minute.

**Still fine** — an SSH tunnel, if you would rather not run anything:

```bash
ssh -R 7777:localhost:7777 you@jumpbox     # on the host
mpx join ws://127.0.0.1:7777/?t=…          # on the jumpbox
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
mpx host --backend codex --backend-bin /opt/bin/codex          --backend-arg --sandbox --backend-arg workspace-write
```

`--backend-bin` picks the binary; `--backend-arg` is repeatable and appended
verbatim, last, so it overrides what the profile built.

### Riding a session that is already shared

Some of these tools have their own sharing, and where they do, mpx can sit on
top of it rather than compete with it.

```bash
# OpenCode's server already accepts several clients on one session.
opencode serve --port 4096
mpx host --backend opencode --attach http://localhost:4096

# Continue a session that already exists, in any backend that has one.
mpx host --backend claude-code --resume 8f3a…
mpx host --backend codex       --resume th_abc123
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

## Use as a Claude Code skill

The repo ships a skill, so inside Claude Code you can say
*"start a multiplayer session for this repo"* or run `/multiplayer`:

```bash
cp -r skills/multiplayer ~/.claude/skills/
```

---

## Development

```bash
npm install
npm run build
npm test          # 102 tests: gate logic, room rules, CLI adapters, relay, live sessions
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
src/client/           connection, commands, terminal UI
```

Adding a CLI is a profile, not a class: build an argv, say whether output is
JSONL or text, and map that tool's events onto the room's. The adapters are
tested against stub binaries that emit exactly what each tool documents, so
flag construction and event mapping are covered without the tool installed.

`gate.ts` is deliberately pure: same inputs, same verdict, with `now` passed in.
Every voting rule in the table above is a unit test.

## License

MIT
