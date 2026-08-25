# Getting started

## Install

```bash
npm install -g multiplayer-cli
```

Node 20.11 or newer. Only the person starting the room needs this and a coding
CLI they are logged into. Everyone else joins with `mpx`, or from a browser with
nothing installed.

## Start a session

```bash
mpx share
```

```
  amber-ridge-04   claude-code  ·  ~/work/api
  found `claude` on your PATH
  prompts: majority+veto 45s   tools: claude-code's own permissions

  Send this to your team:

    http://192.168.1.20:7777/s/amber-ridge-04#t=Kf3nQ8vLm2
```

`mpx share` picks whichever coding CLI you already have — Claude Code, Codex,
Copilot, OpenCode — binds where your team can reach it, and prints a link. With
no CLI installed at all it still runs, on an offline demo backend, so you can
see how a room works before anything is real.

Nothing else needs configuring. If you want to change something, see
[Deciding together](./deciding.md) and [Backends](./backends.md).

## Invite people

Paste the link wherever your team is. **Treat it like a password** — the token
in it is what admits people to the room.

Whoever opens it lands on a page with two ways in:

- **A seat in the browser.** No install, no key. They can read the session,
  propose, vote, and veto.
- **A terminal seat.** The page shows the exact command:
  ```bash
  npx multiplayer-cli join ws://192.168.1.20:7777/r/amber-ridge-04?t=Kf3nQ8vLm2
  ```

`mpx join` also accepts the share link itself, so pasting what was in chat
works either way.

For a read-only seat:

```bash
mpx join <link> --observer
```

## Take a turn

**Typing is proposing.** A line of text does not go to the model — it becomes a
numbered proposal the room votes on.

```
  ▸ alice proposes #4
      rewrite the auth middleware to use short-lived JWTs
      [2/3 ✓ · 1 pending · 18s left]  ✓alice ✓bob   /y #4  /n #4  /amend #4 …
```

| | |
|---|---|
| `/y [#id]` | approve — defaults to the newest open proposal |
| `/n [#id] [reason]` | reject; the reason is recorded with the decision |
| `/abstain [#id]` | no opinion, so the room stops waiting on you |
| `/amend [#id] <text>` | rewrite a pending proposal — this clears its votes |
| `/withdraw [#id]` | take back your own proposal |
| `/race [n] <prompt>` | try it n ways at once, then vote on the diffs |
| `/ask <q> \| <a> \| <b>` | put a fork to the room and let it pick the direction |
| `/fork` | show the fork the room is deciding, if there is one |
| `/lanes [n]` | what the lanes are doing; with a number, the host sets the default |
| `/say <text>` | talk to the room without spending a turn |
| `/stop` | interrupt the running turn (also `Ctrl-C`) |
| `/queue` `/who` `/status` | what's pending, who's here, what's going on |
| `/policy` | show or change the room's rules (host only) |
| `/me <name>` | change your display name |
| `/help` | everything |

The same slash commands work in the browser seat.

## Afterwards

Every room writes an audit log to `.mpx/<room>.jsonl` — who proposed what, who
approved, who vetoed and why, and what the model did about it.

```bash
mpx transcript .mpx/amber-ridge-04.jsonl           # full replay
mpx transcript .mpx/amber-ridge-04.jsonl --votes   # just the decisions
```

Turn it off with `--no-transcript`.

## Where to next

- [The terminal seat](./the-screen.md) — the panes, the keys, and `--plain`
- [Deciding together](./deciding.md) — the voting rules and how to tune them
- [Racing](./racing.md) — one prompt, several attempts, one vote on the result
- [Crossroads](./crossroads.md) — when the agent asks the room which way to go
- [Backends](./backends.md) — which AI CLI runs the session
- [Reaching your team](./relay.md) — LAN, relay, tunnels
- [Security model](./security.md) — what the token protects and what it does not
