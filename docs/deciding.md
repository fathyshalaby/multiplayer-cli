# Deciding together

How the room votes. Everything here has a working default — you can skip this
page entirely until a room needs something different.

## The short version

Pick a preset that matches your group:

```bash
mpx share --policy strict
```

| Preset | A prompt is sent when | Good for |
|---|---|---|
| `solo` | immediately — no vote | a shared screen with no ceremony |
| `pair` | everyone consents; 20s timer; any veto stops it | two or three people |
| `team` *(default)* | a majority agrees; 45s timer; veto stops it | a working group |
| `strict` | everyone actively says yes; no timers | production, or an audience you don't know |
| `host` | the host says so | demos and workshops |
| `round-robin` | whoever holds the mic proposes | structured sessions |

`mpx policies` prints this table with the exact settings behind each one.

## The rules underneath

These apply in every preset.

**A veto is absolute.** Where `veto` is on, one `no` ends the proposal no matter
how many yeses it has. The reason you type with `/n` is recorded as the
justification.

**The timer means "silence is consent".** When it expires with no objection, the
proposal goes. That keeps a room moving when someone has stepped away. Set
`minYes` to make silence mean "not yet" instead, or `timeout=off` to require a
real vote every time.

**Amending clears the votes.** People approved the old wording, not the new one.

**Only people actually present count.** The electorate is recomputed on every
evaluation, so a laptop closing mid-vote cannot deadlock a room waiting for
unanimity — and someone leaving can complete a vote that was waiting on them.

**Rejection is announced as soon as it is certain.** If enough people have said
no that the threshold can no longer be reached, the room says so immediately
rather than waiting out a timer that cannot change the outcome.

**A one-person room is not blocked.** Your own prompts go straight through. Your
tool calls still do not, so a lone operator is still asked before a shell
command runs.

**Observers do not count.** They cannot propose, cannot vote, and are not part
of the electorate — nor can one ever end up hosting the room.

**Somebody is always the host.** The first person who can vote takes the room,
and if they leave it passes to whoever has been there longest. An observer
arriving before anyone else does not take it, and does not stop the next
arrival from taking it.

## Modes

If a preset is close but not right, change its mode:

| Mode | Approves when |
|---|---|
| `open` | immediately — no gate |
| `owner` | the host votes yes |
| `majority` | more than half of the people present |
| `quorum` | a fixed number of approvals (`--set quorum=3`) |
| `consensus` | everyone present has voted yes |
| `round-robin` | the author holds the mic |

## Tuning

```bash
mpx share --policy team --set mode=quorum --set quorum=3 --set timeout=90s
mpx share --policy strict --set tool.mode=owner --set autoAllow=read,write
mpx share --policy pair --set timeout=off
```

Mid-session, host only:

```
/policy strict
/policy mode=consensus timeout=30s
```

Changing the policy re-evaluates everything currently open, so loosening a rule
resolves what was pending.

| Key | Meaning |
|---|---|
| `mode` | one of the modes above |
| `quorum` | approvals needed in `quorum` mode |
| `veto` | a single `no` ends it |
| `timeout` | silence-is-consent window (`45s`, `2m`, `off`) |
| `minYes` | approvals required when the timer fires |
| `proposerAutoYes` | the author's own vote is implied |
| `soloBypass` | skip the ceremony in a one-person room |
| `autoAllow` | tool risk levels that skip the vote: `read`, `write`, `exec` |
| `interrupt` | who may stop a running turn: `anyone`, `owner`, `proposer` |
| `merge` | bundle prompts approved while the model was busy into one turn |
| `attribute` | tell the model who wrote and who approved each message |

A typo in a safety setting is reported, not silently ignored.

## Four things get voted on, not one

Prompts are the obvious one. There are three more, each with its own gate and
its own prefix:

| Prefix | Gates | Has a timer? |
|---|---|---|
| *(none)* | prompts headed for the model | yes, in most presets |
| `tool.` | the model's own tool calls | no |
| `lane.` | landing a [race](./racing.md) in the repository | never |
| `choice.` | ratifying a direction at a [crossroads](./crossroads.md) | never |

Every key in the table above works under each prefix:

```bash
mpx share --set tool.mode=owner --set lane.mode=consensus
```

The last two never have a timer in any preset. Silence can approve a message; it
cannot approve a merge, and it cannot pick a direction.

## Voting on the model's tool calls

When the room owns the agent loop, the model's tool calls go through the same
gate as prompts. `bash: rm -rf build/` becomes a proposal, and the turn genuinely
blocks until the room answers. A denial goes back to the model as a decision
rather than an error, so it explains what it would have done instead.

**This works on the `anthropic` and `echo` backends only.** The other CLIs run
their own agent loops and never ask us, so their own permission systems apply
instead — see [Backends](./backends.md).

---

[← All documentation](./README.md)
