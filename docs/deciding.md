# Deciding together

The gate is the point of this tool, so it is configurable rather than
opinionated. Everything here has a working default; you can ignore all of it
until a room needs something different.

## Presets

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

Landing a [race](./racing.md) has its own gate under `lane.`, and ratifying a
direction at a [crossroads](./crossroads.md) has one under `choice.`. Neither
has a timer in any preset: silence is consent for a question, not for a merge
and not for a direction.

```bash
mpx share --policy strict
```

## Modes

| Mode | Approves when |
|---|---|
| `open` | immediately — no gate |
| `owner` | the host votes yes |
| `majority` | more than half of the people present |
| `quorum` | a fixed number of approvals (`--set quorum=3`) |
| `consensus` | everyone present has voted yes |
| `round-robin` | the author holds the mic |

## The rules underneath

**Veto is absolute.** Where `veto` is on, one `no` ends the proposal regardless
of how many yeses it has. The reason typed with `/n` becomes the recorded
justification.

**The timer is lazy consensus.** When it expires with no objection, the proposal
ships. That keeps a room moving when someone has stepped away. Set `minYes` if
you want silence to mean "not yet" instead, or `timeout=off` to require an
actual vote every time.

**Amendments clear votes.** People approved the old wording, not the new one.

**The electorate is who is actually here.** It is recomputed on every
evaluation, so a laptop closing mid-vote cannot deadlock a consensus room, and a
departure can complete a vote that was waiting on the person who left.

**Rejection is declared as soon as it is certain.** If enough people have said
no that the threshold can no longer be reached, the room says so immediately
rather than waiting out a timer that cannot change anything.

**A one-person room is not blocked.** `soloBypass` sends your own prompts
straight through — but never your tool calls, so a lone operator is still asked
before a shell command runs.

**Observers do not count.** They cannot propose, cannot vote, and are not part of
the electorate.

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
| `timeout` | lazy-consensus window (`45s`, `2m`, `off`) |
| `minYes` | approvals required when the timer fires |
| `proposerAutoYes` | the author's own vote is implied |
| `soloBypass` | skip the ceremony in a one-person room |
| `tool.*` | all of the above again, for the model's tool calls |
| `lane.*` | and again, for landing a [race](./racing.md) in the repository |
| `choice.*` | and again, for ratifying a direction at a [crossroads](./crossroads.md) |
| `autoAllow` | tool risk levels that skip the vote: `read`, `write`, `exec` |
| `interrupt` | who may stop a running turn: `anyone`, `owner`, `proposer` |
| `merge` | bundle prompts approved while the model was busy into one turn |
| `attribute` | tell the model who wrote and who approved each message |

A typo in a safety setting is reported, not silently ignored.

## Voting on the model's tool calls

When the room owns the agent loop, the model's tool calls go through the same
gate as prompts. `bash: rm -rf build/` becomes a proposal, and the turn genuinely
blocks until the room answers. A denial goes back to the model as a decision
rather than an error, so it explains what it would have done instead.

This works on the `anthropic` and `echo` backends. The other CLIs run their own
agent loops and never ask, so their own permission systems apply — see
[Backends](./backends.md).
