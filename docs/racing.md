# Racing: one prompt, several attempts

A vote answers "should we send this?" It does not answer "was that the right
way to do it?" — and that second question is the harder one, because nobody
knows until somebody tries.

Racing tries several answers at once. The room approves one prompt; the room
server runs it *n* times in parallel, each agent in its own git worktree on its
own branch. When they finish, the room gets a diffstat per lane and votes on
which one lands.

```
                 ┌── lane A ──> branch mpx/room/turn/a ──┐
approved prompt ─┼── lane B ──> branch mpx/room/turn/b ──┼─> the room votes
                 └── lane C ──> branch mpx/room/turn/c ──┘        │
                                                                  v
                                            git merge --no-ff into your checkout
```

## Using it

```
/race add retries to the http client        # as many lanes as the room uses
/race 4 add retries to the http client      # exactly four
/lanes                                      # what the lanes are doing
/lanes 2                                    # host: change the default
/lanes 0                                    # host: turn racing off
```

A race is a normal proposal first: it goes through the room's prompt gate like
anything else, and the vote line says `(race, 3 lanes)` so nobody approves three
agents' worth of work by accident.

At the host:

```bash
mpx share --lanes 3                  # the default
mpx share --lanes 0                  # no racing in this room
mpx share --lane-setup "npm ci"      # run this in each fresh checkout first
```

The ceiling is six lanes. Every lane is a real agent doing real work on
somebody's real subscription.

## What each lane sees

A lane is `git worktree add -b <branch> <dir> HEAD`. That means:

- **It branches from your last commit, not your working tree.** Uncommitted
  work is invisible to every lane. The room says so before the race starts if
  your checkout is dirty.
- **It has no ignored files.** No `node_modules`, no `.venv`, no `.env`, no
  build output — those are not in git, so they are not in the worktree. This is
  what `--lane-setup` is for: it runs in each lane's checkout before the agent
  starts, so `--lane-setup "npm ci"` or `--lane-setup "ln -s ../../node_modules ."`
  gives the agent something it can actually run.
- **It starts a fresh session.** A lane does not inherit the room's
  conversation: no CLI can fork a session, and two lanes resuming the same
  thread would trample each other's history. The lane gets the prompt and the
  repository, and that is all. Say what you want in the prompt.
- **Its tool calls are not voted on.** A lane works on a throwaway branch, so
  there is nothing for the room to protect by approving each step. The vote that
  matters is the one at the end, on the diff.

Lanes are told they are one of several parallel attempts, that nobody is
watching them individually, and that they should commit to an approach rather
than ask a question they will get no answer to.

## What comes back

When every lane has finished, each one's work is committed to its own branch and
the room sees:

```
  ✓ A  3 files +64 -12
      src/http.ts   | 41 +++++++++----
      test/http.ts  | 23 ++++++++
       3 files changed, 64 insertions(+), 12 deletions(-)
      mpx/api/turn_8fQ2/a
  ·  B  finished without changing anything
  ✗ C  exit 1: cannot find module 'undici'
```

In the full-screen seat the lanes and their votes stand in the sidebar while
the race runs, rather than scrolling past — see
[The terminal seat](./the-screen.md).

Then one proposal per lane that actually produced changes. Approving one merges
it; the others are withdrawn. Voting them all down lands nothing, which is a
legitimate outcome — you learned that none of the three approaches was right,
for the price of finding out in parallel.

Landing is `git merge --no-ff` into the branch the room is hosted on, so
"we raced three attempts and took B" stays legible in `git log`.

## Looking, not just reading

A diffstat is a fine ballot for a parser and a poor one for a page. `4 files
changed, +120 −30` does not tell a room whether the layout is right, and asking
people to vote on it anyway is asking them to guess.

So a lane can be *started* as well as read. Give the room a preview command and
each finished lane gets its own port and its own running copy:

```
mpx share --lanes 3 --lane-setup "npm ci" --lane-preview "npm run dev -- --port {port}"
```

`{port}` is substituted, and `PORT` is set in the environment for the many
tools that read it instead. Lanes take the next free port from `4173` up
(`--lane-preview-port`), probed before it is handed out, so two lanes in the
same race never collide.

```
  ✓ A  3 files +64 -12
      http://127.0.0.1:4173
  ✓ B  2 files +31 -4
      preview starting…
  ✓ C  5 files +88 -20
      preview failed: the preview command exited without listening — Error: Cannot find module 'vite'
```

The room reads the diff and clicks around the thing, then votes. A preview that
will not start is reported on its lane and nothing more: the lane is still
committed, still has a branch, and is still votable on its diff.

Previews are not free, which is why there is no default. Three lanes is three
dev servers, three `node_modules`, and three of whatever your app opens on
boot. Turn them on for work with a screen and leave them off for the rest.

### Where the preview is running

On the host's machine, bound wherever the preview command binds it — by default
that is localhost, reachable by seats on that machine and nobody else. A host
whose teammates can reach them over the network can bind wider and set
`--lane-preview-host` to the name those teammates use, and the room will be
shown a URL that works for them.

There is no tunnel through the relay. That is a deliberate gap rather than an
oversight: piping a modern dev server through the room's frames means a service
worker rewriting every asset URL and a hot-reload socket that will not survive
the trip, and it would be a lot of machinery to arrive somewhere unreliable.
Seats that cannot reach the host can check out the lane's branch instead — it is
already there, which is the whole point of leaving them behind.

## When to ask instead

Racing answers "which approach?" by building all of them. When the fork is
about *intent* rather than code — must this stay backwards compatible, how much
scope do we take on — no amount of running the code settles it, and three lanes
would spend three agents producing three correct answers to a question only the
room can decide. [Crossroads](./crossroads.md) costs a paragraph instead.

## The lane gate

Landing has its own gate, separate from prompts and tools, because merging into
a shared repository is a different decision from sending a message:

| Preset | Landing needs |
|---|---|
| `solo` | the host |
| `pair` | everyone present |
| `team` | a majority |
| `strict` | everyone present |
| `host` | the host |
| `round-robin` | a majority |

None of them has a timer. Silence is consent for a question; it is not consent
for a merge.

```bash
mpx share --set lane.mode=consensus
```

`/policy lane.mode=owner` changes it mid-session. All the usual gate keys work
under the `lane.` prefix — see [Deciding together](./deciding.md).

## What it costs, and what it does not clean up

Three lanes is three times the tokens and three times the wall-clock spend on
whoever's account is hosting. Races run on the host's backend; account pooling
does not spread them.

The checkouts are deleted when the race ends. **The branches are kept**, and the
room prints their names:

```
· lane branches kept: mpx/api/turn_8fQ2/a, mpx/api/turn_8fQ2/b — delete with git branch -D
```

A lane nobody voted for is still work somebody might want, and deleting a branch
in someone else's repository is not a decision this tool should make on its own.

## When it will not race

- **Not a git repository.** Lanes are branches. `mpx share` says so in the
  invite banner rather than waiting for someone to type `/race`.
- **No commits yet.** There is nothing to branch from.
- **A race is already waiting on a vote.** One at a time: they all write to the
  same repository, and a room choosing between six diffs from two different
  questions is worse than waiting.
- **Your checkout has uncommitted changes.** This one is a warning, not a
  refusal — the race runs, from your last commit, and landing will refuse to
  merge over your uncommitted work and tell you the branch name instead.
