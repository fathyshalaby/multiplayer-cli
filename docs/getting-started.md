# Getting started

Five minutes, start to finish. By the end you will have a room running, a link
sent, and a turn taken.

## 1. Install

The package is not on npm yet, so run it straight from the repo:

```bash
npx github:fathyshalaby/multiplayer-cli share
```

Once it is published, this will be the shorter form:

```bash
npm install -g multiplayer-cli    # not available yet
```

The rest of these docs write `mpx` for brevity. If you are using the `npx`
form, substitute `npx github:fathyshalaby/multiplayer-cli` wherever you see it.

You need Node 20.11 or newer. **Only the host needs any of this** — and a coding
CLI they are signed into. Everyone else joins with a link.

## 2. Start a room

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

That is the whole setup. `mpx share` finds whichever coding CLI you already have
— Claude Code, Codex, Copilot, OpenCode and others — binds where your team can
reach it, and prints a link.

**No coding CLI installed?** It still runs, on an offline stand-in backend, so
you can see how a room works before anything is real.

## 3. Invite people

Paste the link wherever your team is.

**Treat the link like a password.** The `#t=…` on the end is the key to the
room, not just an address.

Whoever opens it gets a page with two ways in:

- **A seat in the browser** — nothing to install, no API key. They can read the
  session, propose, vote and veto, exactly like a terminal seat.
- **A terminal seat** — the page shows the command to copy.

To join from a terminal yourself:

```bash
mpx join <link>                # the share link works as-is
mpx join <link> --observer     # read-only: sees everything, proposes nothing
```

## 4. Take a turn

**Typing is proposing.** A line of text does not go to the model. It becomes a
numbered proposal that the room votes on.

```
  ▸ alice proposes #4
      rewrite the auth middleware to use short-lived JWTs
      [2/3 ✓ · 1 pending · 18s left]  ✓alice ✓bob   /y #4  /n #4  /amend #4 …
```

The five commands that cover most sessions:

| | |
|---|---|
| `/y` | approve the newest open proposal |
| `/n <reason>` | reject it — the reason is recorded with the decision |
| `/say <text>` | talk to the room without spending a turn |
| `/stop` | interrupt the running turn (also `Ctrl-C`) |
| `/who` | who is in the room |

`/help` shows these; `/help all` shows everything. The same commands work in the
browser seat.

<details>
<summary>The full command list</summary>

| | |
|---|---|
| `/y [#id]` | approve — defaults to the newest open proposal |
| `/n [#id] [reason]` | reject; the reason is recorded with the decision |
| `/abstain [#id]` | no opinion, so the room stops waiting on you |
| `/amend [#id] <text>` | rewrite a pending proposal — this clears its votes |
| `/withdraw [#id]` | take back your own proposal |
| `/race [n] <prompt>` | try it n ways at once, then vote on the diffs |
| `/split <a> \| <b>` | different work in parallel lanes, each landing on its own |
| `/lanes [n]` | what the lanes are doing; with a number, the host sets the default |
| `/ask <q> \| <a> \| <b>` | put a fork to the room and let it pick the direction |
| `/fork` | show the fork the room is deciding, if there is one |
| `/say <text>` | talk to the room without spending a turn |
| `/stop` | interrupt the running turn |
| `/queue` `/who` `/status` | what's pending, who's here, what's going on |
| `/policy` | show or change the room's rules (host only) |
| `/me <name>` | change your display name |
| `/help` | the handful you need; `/help all` for the rest |

</details>

## 5. Afterwards

Every room writes an audit log to `.mpx/<room>.jsonl`: who proposed what, who
approved, who vetoed and why, and what the model did about it.

```bash
mpx transcript .mpx/amber-ridge-04.jsonl           # full replay
mpx transcript .mpx/amber-ridge-04.jsonl --votes   # just the decisions
```

Turn it off with `--no-transcript`.

## Where to next

Nothing below is required. A room works with none of it.

- [Deciding together](./deciding.md) — change how the room votes
- [Backends](./backends.md) — pick which AI CLI runs the session
- [Reaching your team](./relay.md) — when teammates are not on your network
- [Racing](./racing.md) — try one prompt several ways and vote on the results
- [Crossroads](./crossroads.md) — let the agent ask the room which way to go
- [Security model](./security.md) — what the link protects, and what it does not

---

[← All documentation](./README.md)
