---
name: multiplayer
description: Start a shared multiplayer AI session and get a link to send teammates, using multiplayer-cli (mpx). The group proposes and votes on what gets sent to the model, and works with Claude Code, Codex, Copilot CLI and OpenCode. Use when the user wants to pair or mob on a session, share their AI session with colleagues, invite someone into what they are working on, get a second pair of eyes before something is sent, or set up group review of prompts and tool calls.
---

# Share this session with your team

`multiplayer-cli` turns one AI session into a room several people share. Everyone
sees the same transcript, and nothing reaches the model until the room agrees.

## Start it

```bash
mpx share
```

That is the whole thing. It picks whichever coding CLI is already installed,
starts a room, and prints a link. If `mpx` is missing, install it first with
`npm install -g multiplayer-cli`.

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

**Which AI.** `--backend claude-code | codex | copilot | opencode | anthropic`.
`mpx backends` shows what is installed and which one `mpx share` would pick.

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
interrupts. `/help` lists the rest.

## Afterwards

Every room writes `.mpx/<room>.jsonl` — who proposed, who approved, who vetoed
and why.

```bash
mpx transcript .mpx/<room>.jsonl --votes
```

## Worth saying out loud

- Only the host needs credentials and a coding CLI installed.
- Tools run on the **host's** machine in `--cwd`, and everyone in the room can
  propose work that touches it. Invite accordingly; `--policy strict` puts every
  write and every command in front of a unanimous vote.
- The room always votes on what gets **sent**. Only the `anthropic` and `echo`
  backends also vote on the model's **tool calls** — the other CLIs run their
  own agent loops and enforce their own permissions.
- `--backend echo` is a complete dry run with no key and no spend. Use it to
  show someone how a room works before doing anything real.
