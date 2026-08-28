---
name: multiplayer
description: Start a shared multiplayer AI session and get a link to send teammates, using multiplayer-cli (mpx). The group proposes and votes on what gets sent to the model, and it drives whichever coding CLI is installed — Claude Code, Codex, Copilot, OpenCode, Gemini, Cursor, Aider or Amp. Use when the user wants to pair or mob on a session, share their AI session with colleagues, invite someone into what they are working on, get a second pair of eyes before something is sent, set up group review of prompts and tool calls, try one prompt several ways at once and vote on the diffs, or have the agent put a fork to the group instead of guessing.
---

# Share this session with your team

`multiplayer-cli` turns one AI session into a room several people share. Everyone
sees the same transcript, and nothing reaches the model until the room agrees.

## Start it

```bash
mpx share
```

That is the whole thing. It picks whichever coding CLI is already installed,
starts a room, and prints a link.

If `mpx` is missing, run it straight from the repo instead — the package is not
on npm yet, so this is the form that works today:

```bash
npx github:fathyshalaby/multiplayer-cli share
```

Once it is published, `npm install -g multiplayer-cli` will put `mpx` on the
PATH.

Then **give the user the link verbatim** and tell them to paste it wherever
their team is. Do not shorten it, and do not paste it anywhere yourself — the
token in it is the key to the room.

Whoever opens the link gets a page with two ways in: a seat right there in the
browser, or the one-line command to join from a terminal. Neither needs an API
key or the coding CLI — only the host does.

## Choosing options, only when they matter

Everything below has a working default. Reach for these when the user's
situation calls for it, not by habit.

**Who can reach it.** `mpx share` binds to the local network, so anyone on the
same wifi or VPN can open the link. If that is not enough:

```bash
mpx share --local              # this machine only
mpx share --relay wss://…      # reachable anywhere; remembered from then on
```

A relay is any box the team can reach; `mpx relay` runs one. Tell the user
plainly that a relay carries session content in the clear, so it should be
theirs and behind TLS. It never receives the room token and cannot admit anyone
the host would refuse.

**How the room decides.** Default is `team` — majority plus a veto, with a 45s
timer where silence counts as consent. Change it for the situation:

- `--policy pair` — two or three people; anyone can veto
- `--policy strict` — unanimous, no timers. Production, or an audience the user
  does not fully know
- `--policy host` — the user drives, everyone else suggests. Demos
- `--policy solo` — no gate at all, just a shared screen

**Which AI.** `--backend claude-code | codex | copilot | opencode |
opencode-json | gemini | cursor | aider | amp | anthropic | echo`.
`mpx backends` shows what is installed and which one `mpx share` would pick.
Prefer letting it detect; name one only when the user asks for that AI.

**A session that already exists.** `--resume <id>` continues one the backend
already has. `--attach <url>` points OpenCode at a running `opencode serve`
other clients may already be on.

## Joining someone else's

```bash
mpx join <the link they sent>
```

Add `--observer` for a read-only seat.

## In the session

Bare text is a proposal, not a message — typing is suggesting. `/y` approves,
`/n <reason>` vetoes and records the reason, `/amend` rewrites a proposal and
clears its votes, `/say` talks to the room without spending a turn, `/stop`
interrupts. `/help` lists those; `/help all` lists everything else.

## Working in parallel, when the room cannot decide by talking

Only in a git repository, and only when it earns itself — each lane is a fresh
worktree with its own agent, so three lanes is three of everything.

- `/race [n] <prompt>` — the same prompt attempted n ways at once. The room
  reads the diffs and lands **one**. For "which approach?", where building all
  of them is cheaper than arguing about them.
- `/split <a> | <b>` — one prompt per lane, different work, and the room decides
  about **each** on its own. For "these two things at once", where the lanes are
  halves of one change rather than rival versions of it. It warns if two lanes
  touched the same file.
- `--lane-preview "<cmd>"` — start each finished lane on its own port so the
  room can look at it instead of reading a diffstat. Suggest this when the work
  has a screen; a diffstat is a poor ballot for a page.

## Asking the room yourself

If you reach a fork you cannot settle — a decision rather than a fact, like how
much scope to take on or whether to stay backwards compatible — put it to the
room instead of guessing:

```
[[crossroads]]
Which way?
- Keep the old signature — callers stay working, we carry the shim
- Break it now — cleaner, but every caller needs a change
[[/crossroads]]
```

The room votes and tells you which. `/ask <q> | <a> | <b>` does the same from a
person's side. Use it for questions running the code cannot answer — otherwise
`/race` them and let the diffs decide.

## Afterwards

Every room writes `.mpx/<room>.jsonl` — who proposed, who approved, who vetoed
and why.

```bash
mpx transcript .mpx/<room>.jsonl --votes
```

## Worth saying out loud

- Nobody needs an API key. The room runs on whichever CLI the host is already
  logged into, and joining from a browser needs nothing installed.
- Every turn runs on the host's account. There is an experimental way to spread
  that across the room — `mpx share --pool` plus `mpx join --runner` — but do
  not reach for it unless the user raises hitting a usage limit. It changes
  which machine tools act on, so it is not a free upgrade.
- Tools run on the **host's** machine in `--cwd`, and everyone in the room can
  propose work that touches it. Invite accordingly; `--policy strict` puts every
  write and every command in front of a unanimous vote.
- The room always votes on what gets **sent**. Only the `anthropic` and `echo`
  backends also vote on the model's **tool calls** — the other CLIs run their
  own agent loops and enforce their own permissions.
- `--backend echo` is a complete dry run with no key and no spend. Use it to
  show someone how a room works before doing anything real.
