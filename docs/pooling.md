# Account pooling &nbsp;·&nbsp; experimental

*Spreading turns across several people's accounts, so one usage limit does not stop the room.*

**Off by default, and the default is the one to reach for first.** Every turn
runs on the host's account, on the host's machine. That is one account, one
place the tools act, and it is what most rooms want.

This page is about what to do when one account is not enough.

## Turning it on

Both sides opt in:

```bash
mpx share --pool          # host: allow seats to take turns
mpx join <link> --runner  # seat: offer your machine and subscription
```

A seat that volunteers into a room without `--pool` is told so, and told the
flag that would change it.

## What happens

The room stays on one account for as long as it can, because staying put is what
keeps a session coherent — the underlying tool resumes its own thread and keeps
its own cache. It moves only when an account reports it is out of capacity:

```
  · alice's claude-code is out of capacity until 3:00:00 PM
  ⇄ the session moved to bob's codex
  · picking up on bob's codex session
```

`/who` shows who is carrying it:

```
  running on 2 accounts
      alice-mbp        claude-code    out of capacity until 3:00:00 PM   4 turns
    ▸ bob              codex          running                            1 turn
```

Only a **capacity** failure hands off. A plain bug fails once and is reported —
burning through everyone's account to produce the same error four times helps
nobody.

## Nobody shares credentials

Every account runs only on the machine it is logged in on. A turn that spends
bob's subscription runs on bob's laptop, under bob's login, on a prompt bob's
room approved. mpx never sees, moves, or asks for anyone's token.

## The tool gate does not follow a turn onto a runner

On `anthropic` and `echo` the room votes on the model's tool calls, because
those are the two backends where mpx owns the agent loop. **That stops at the
edge of the host's machine.**

A runner runs the loop locally and approves its own tool calls, so a turn routed
to a runner executes them without a vote — the same turn, on the host, would
have stopped and asked the room. In a `strict` room, where nothing is
auto-allowed and every command is supposed to need unanimity, this is quietly
weaker than what was asked for.

The room says so when such a runner joins, and the runner says so on its own
machine:

```
· note: bob's anthropic turns approve their own tool calls — this room votes
  on tool calls only for turns it runs itself
```

For a CLI backend there is nothing to say: `codex`, `claude-code` and the rest
run their own agent loops and their own permission systems, and the room never
saw their tool calls to vote on in the first place.

Closing this properly means carrying each approval back over the socket and
holding the turn until the room answers — a protocol change, and one that needs
an answer for a runner that drops mid-vote. Until then: if the tool gate is the
reason you are using this, do not pool `anthropic` runners.

## Why it is experimental

Three real limits, all of which change behaviour rather than just performance:

**A handoff is a summary, not a transplant.** The room owns the only complete
record of the session and carries that across, but the new tool has none of the
previous one's tool results, file state or cache. The recap tells it so
explicitly rather than letting it assume continuity it does not have.

**Tools act on the runner's own checkout.** The shared object is the session,
not the filesystem. A turn that lands on bob's machine reads and writes bob's
copy of the repo — which may be a different branch, or a different project
entirely. Each runner's working directory is shown in `/who` and `/status` so
this is visible, but it is a difference you have to actually want.

**The tool gate stops at the host.** As above — a turn on a runner approves its
own tool calls.

If any of those is not acceptable for what you are doing, leave pooling off.

---

[← All documentation](./README.md)
