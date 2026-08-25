# Crossroads: when the agent asks the room

The room has gates in one direction — people interrupting the agent:

| When | Gate | Question |
|---|---|---|
| Before | `prompt` | should we send this? |
| During | `tool` | may it run this? |
| After | `lane` | which diff lands? |

Crossroads is the other direction. The agent reaches a real fork — two or more
defensible ways forward, where picking wrong means redoing the work — and stops
to ask the room which way to go, *before* spending it.

```
  ⑂ codex asks the room to pick a direction
    Should the v1 API keep working after this change?

    ⑂ #2 a — Shim it
        keep v1 alive behind an adapter, slower but nobody has to move
      [0/3 ✓ · 3 pending]   /y #2  /n #2

    ⑂ #3 b — Migrate
        drop v1 and update every caller in one go
      [0/3 ✓ · 3 pending]   /y #3  /n #3
```

Approve one and that direction is ratified; the others close, and the agent is
told what the room chose.

## Why it is not just racing

[Racing](./racing.md) answers "which approach?" by **building all of them** and
voting on the diffs. That is the right tool when the answer is in the code, and
the wrong one when it isn't.

*"Must v1 keep working?"* is not a technical question with a discoverable
answer. It is a decision about what you are willing to owe your users. No
amount of running the code settles it, so racing three lanes to find out would
spend three agents' worth of work producing three correct answers to a question
only the room can decide.

Crossroads costs a paragraph. Racing costs three worktrees. They answer
different questions, and the cheap one should go first.

## How a fork gets raised

**By a person**, in any room, on any backend:

```
/ask should we keep v1 working? | shim it | migrate and update callers
/fork                                  # what is on the table right now
```

**By the agent**, by writing a block in its output. Every backend streams text,
so every backend can raise one:

```
[[crossroads]]
? Should the v1 API keep working after this change?
- Shim it — keep v1 alive behind an adapter
- Migrate — drop v1 and update every caller
[[/crossroads]]
```

Between two and six options. The block is lifted out of the transcript rather
than read to the room as prose, so what people see is the question and the
votes, not the machinery.

Backends that take our system prompt are told this syntax. The built-in
`anthropic` backend gets a real `ask_room` tool instead, which is more reliable
than asking a model to type a block correctly.

## Waiting, and not pretending to

Only some backends can be held open mid-turn. The room says which is happening
rather than blurring it:

| | |
|---|---|
| `anthropic` | **The turn genuinely pauses.** The answer comes back as the tool result and the agent carries on inside the same turn. |
| every CLI backend | The turn has already finished streaming by the time we see the block. The answer is delivered as the **next message**. |

The second is not a workaround dressed up as the first. A `codex` or `claude`
process has produced its output and exited; there is nothing left to pause.
Saying "the room's answer will go back as the next message" is the truth, and
the room can see which mode it is in.

## Nobody has to pick

Voting every option down abandons the fork, and the agent is told so:

> The room looked at your question and did not pick a direction. Use your
> judgement, and say plainly which way you went and why.

That is a real outcome — sometimes the honest answer is *"we don't know either,
just choose"* — and it is better than a room that cannot say it.

**There is no timer, in any preset.** Lazy consensus is fine for a question;
it is not fine for a direction. A fork that nobody answers stays on the table.

## The gate

Ratifying a direction has its own gate, `choice.*`, alongside `prompt.*`,
`tool.*` and `lane.*`:

| Preset | A direction needs |
|---|---|
| `solo` / `host` | the host |
| `pair` / `strict` | everyone present |
| `team` / `round-robin` | a majority |

```bash
mpx share --set choice.mode=consensus
```

One fork at a time. A room being asked two questions at once cannot answer
either of them properly, so a second `/ask` is refused until the first settles.

## Where it comes from

Fathy's collaborator proposed this: *ratification when the agent is at the
crossroads*. It is the primitive the other three gates were missing — they all
assume the room already knows what it wants, and the interesting moments are
exactly the ones where it has not decided yet.
