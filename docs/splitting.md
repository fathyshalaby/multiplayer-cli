# Splitting: different work, at once

[Racing](./racing.md) opens several lanes on **one** prompt and the room takes
one of them. Splitting opens one lane **per** prompt and the room can take all
of them.

The difference is not the mechanism — it is the same worktrees, the same
`lane.` gate, the same votes. The difference is what the lanes are to each
other.

A race's lanes are **substitutes**. Three attempts at one thing, and picking
one means discarding the rest. "Which of these is right" is a real question
with one answer.

A split's lanes are **complements**. The API and the page that calls it are not
competing versions of one change; they are two halves of one change. "Which is
better, the frontend or the backend" is not a hard question, it is a malformed
one. So approving one lane says nothing about the others, and the room decides
about each in turn.

## Using it

```
/split add the /events API route | add the settings page that calls it
```

Pieces are separated by `|`, two to six of them, and each becomes a lane in the
order written — A, B, C. Blank pieces are dropped rather than opened as empty
lanes.

Each lane gets its own fresh worktree from the room's HEAD, its own agent, and
its own prompt. They run at the same time and know nothing about each other,
which is the trade: no coordination, no waiting, and no way for B to build on
what A just wrote.

## What comes back

One vote per lane, all open at once, each naming what it was asked:

```
  ✓ A  2 files +48 -3     land lane A — add the /events API route — 2 files +48 -3
  ✓ B  3 files +71 -12    land lane B — add the settings page that calls it — 3 files +71 -12
```

Approving A merges A. B stays exactly where it was — still committed, still on
its branch, still a live question. Approve it too and it merges on top. Reject
it and it is dropped, and the split ends once the room has decided about every
lane, not once it has decided about one.

Merges are queued rather than concurrent: two `git merge` calls at once in the
same checkout is a corrupted index, and B's conflicts are only knowable after A
has landed anyway. If B then fails to merge, the room is told so and pointed at
B's branch — the work is not lost, it just needs a human.

## When two lanes want the same file

Before the votes open, a split checks which files each lane touched and says so
if any of them collide:

```
lanes overlap: src/types.ts (A, B); src/router.ts (A, B) — landing both may conflict
```

That is either duplicated effort — two agents independently doing the same
thing, which is money spent twice — or a merge conflict the room has not met
yet. Both are worth knowing *before* voting rather than after.

It is only ever a warning. Two lanes touching one file is often exactly right —
a route and its test, an interface and its implementation — and a tool that
refuses to proceed on a heuristic is a tool people learn to route around.

A race says nothing about overlap. Its lanes are three tries at the same work,
so of course they touch the same files; flagging it would be noise.

## Racing, splitting, or asking

|  | what the lanes are | what the room does |
|---|---|---|
| [`/race`](./racing.md) | attempts at one thing | picks one, discards the rest |
| `/split` | pieces of one thing | decides each on its own |
| [`/ask`](./crossroads.md) | nothing runs | answers a question in a paragraph |

Reach for a race when you do not know which approach is right and running all
of them is cheaper than arguing. Reach for a split when you already know what
the pieces are and only want them done at once. Reach for a crossroads when the
fork is about *intent* — how much scope, must this stay compatible — because no
amount of running the code settles that, and three lanes would spend three
agents producing three correct answers to a question only the room can decide.

## What it costs

Everything [racing costs](./racing.md#what-it-costs-and-what-it-does-not-clean-up),
per lane, and the same caveats: lanes branch from the last commit and cannot see
uncommitted work, and the branches they leave behind are yours to delete.

Previews work the same way here, and are arguably more useful: a split's lanes
are doing *different* things, so "what does B actually look like" is not
answerable from A.
