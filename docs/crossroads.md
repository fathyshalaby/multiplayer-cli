# Crossroads: when the agent asks the room

Every other gate is the room interrupting the agent. This one is the agent
stopping to ask the room.

| When | Gate | Question | Who asks |
|---|---|---|---|
| Before | `prompt` | should we send this? | the room |
| During | `tool` | may it run this? | the room |
| After | `lane` | which diff lands? | the room |
| **Sideways** | `choice` | **which way should I go?** | **the agent** |

The agent reaches a real fork — two or more defensible ways forward, where
picking wrong means redoing the work — and asks which way *before* spending it.

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

Approve one and that direction is ratified. The others close, and the agent is
told what the room chose.

## Why not just race it?

[Racing](./racing.md) answers "which approach?" by **building all of them** and
voting on the diffs. That is right when the answer is in the code, and wrong
when it is not.

*"Must v1 keep working?"* is not a technical question with a discoverable
answer. It is a decision about what you are willing to owe your users. Running
the code cannot settle it, so racing three lanes would spend three agents'
worth of work producing three correct answers to a question only the room can
decide.

A crossroads costs a paragraph. A race costs three worktrees. Try the cheap one
first.

## Raising a fork

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

## Whether the turn actually pauses

Only some backends can be held open mid-turn. The room tells you which is
happening rather than blurring it:

| Backend | What happens |
|---|---|
| `anthropic` | **The turn genuinely pauses.** The answer comes back as the tool result and the agent carries on inside the same turn. |
| every CLI backend | The turn has already finished streaming by the time we see the block. The answer is delivered as the **next message**. |

The second is not a workaround dressed up as the first. A `codex` or `claude`
process has produced its output and exited; there is nothing left to pause.

## Nobody has to pick

Voting every option down abandons the fork, and the agent is told so:

> The room looked at your question and did not pick a direction. Use your
> judgement, and say plainly which way you went and why.

That is a real outcome — sometimes the honest answer is *"we don't know either,
just choose"* — and it is better than a room that cannot say it.

**There is no timer, in any preset.** Silence is fine for approving a question;
it is not fine for picking a direction. A fork nobody answers stays on the table.

## The gate

Ratifying a direction has its own gate, `choice.*`:

| Preset | A direction needs |
|---|---|
| `solo` / `host` | the host |
| `pair` / `strict` | everyone present |
| `team` / `round-robin` | a majority |

```bash
mpx share --set choice.mode=consensus
```

One fork at a time. A room being asked two questions at once cannot answer
either properly, so a second `/ask` is refused until the first settles.

## Where it comes from

Fathy's collaborator proposed this: *ratification when the agent is at the
crossroads*. It is the primitive the other three gates were missing — they all
assume the room already knows what it wants, and the interesting moments are
exactly the ones where it has not decided yet.

---

[← All documentation](./README.md)
