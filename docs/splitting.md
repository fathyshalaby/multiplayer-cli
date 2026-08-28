# Splitting: different work, at once

[Racing](./racing.md) opens several lanes on **one** prompt, and the room takes
one of them. Splitting opens one lane **per** prompt, and the room can take all
of them.

The mechanism is identical — same worktrees, same `lane.` gate, same votes. What
differs is what the lanes are to each other:

|  | The lanes are | The room |
|---|---|---|
| `/race` | **substitutes** — three attempts at one thing | picks one, discards the rest |
| `/split` | **complements** — two halves of one change | decides each on its own |

"Which of these is right" is a real question with one answer. "Which is better,
the frontend or the backend" is not a hard question — it is a malformed one. So
approving one split lane says nothing about the others.

## Using it

```
/split add the /events API route | add the settings page that calls it
```

Separate the pieces with `|` — two to six of them. Each becomes a lane in the
order written (A, B, C). Blank pieces are dropped rather than opened as empty
lanes.

Each lane gets its own fresh worktree from the room's HEAD, its own agent, and
its own prompt. They run at the same time and know nothing about each other.
That is the trade: no coordination and no waiting, but no way for B to build on
what A just wrote.

## What comes back

One vote per lane, all open at once, each naming what it was asked:

```
  ✓ A  2 files +48 -3     land lane A — add the /events API route — 2 files +48 -3
  ✓ B  3 files +71 -12    land lane B — add the settings page that calls it — 3 files +71 -12
```

Approving A merges A. B stays exactly where it was — still committed, still on
its branch, still a live question. Approve it too and it merges on top. Reject it
and it is dropped. The split ends once the room has decided about *every* lane,
not once it has decided about one.

Merges are queued rather than run concurrently: two `git merge` calls at once in
the same checkout is a corrupted index, and B's conflicts are only knowable after
A has landed anyway. If B then fails to merge, the room is told and pointed at
B's branch — the work is not lost, it just needs a human.

## When two lanes want the same file

Before the votes open, a split checks which files each lane touched and says so
if any collide:

```
lanes overlap: src/types.ts (A, B); src/router.ts (A, B) — landing both may conflict
```

That is either duplicated effort — two agents independently doing the same
thing, which is money spent twice — or a merge conflict the room has not met
yet. Both are worth knowing *before* voting rather than after.

**It is only ever a warning.** Two lanes touching one file is often exactly
right — a route and its test, an interface and its implementation — and a tool
that refuses to proceed on a heuristic is a tool people learn to route around.

A race says nothing about overlap. Its lanes are three tries at the same work, so
of course they touch the same files; flagging it would be noise.

## Which one do I want?

| Reach for | When |
|---|---|
| [`/race`](./racing.md) | you do not know which approach is right, and running all of them is cheaper than arguing |
| `/split` | you already know what the pieces are and just want them done at once |
| [`/ask`](./crossroads.md) | the fork is about *intent* — how much scope, must this stay compatible |

A crossroads is the cheap one. No amount of running the code settles a question
about intent, so three lanes would spend three agents producing three correct
answers to a question only the room can decide.

## What it costs

Everything [racing costs](./racing.md#what-it-costs-and-what-it-leaves-behind),
per lane, with the same caveats: lanes branch from the last commit and cannot
see uncommitted work, and the branches they leave behind are yours to delete.

Previews work the same way here, and are arguably more useful: a split's lanes
are doing *different* things, so "what does B actually look like" is not
answerable from A.

---

[← All documentation](./README.md)
