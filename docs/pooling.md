# Account pooling &nbsp;·&nbsp; experimental

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

## Why it is experimental

Two real limits, both of which change behaviour rather than just performance:

**A handoff is a summary, not a transplant.** The room owns the only complete
record of the session and carries that across, but the new tool has none of the
previous one's tool results, file state or cache. The recap tells it so
explicitly rather than letting it assume continuity it does not have.

**Tools act on the runner's own checkout.** The shared object is the session,
not the filesystem. A turn that lands on bob's machine reads and writes bob's
copy of the repo — which may be a different branch, or a different project
entirely. Each runner's working directory is shown in `/who` and `/status` so
this is visible, but it is a difference you have to actually want.

If either of those is not acceptable for what you are doing, leave pooling off.
