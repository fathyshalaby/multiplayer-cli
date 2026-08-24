---
name: multiplayer
description: Start or join a shared multiplayer AI session with teammates using multiplayer-cli (mpx), where the group proposes and votes on what gets sent to the model. Works with Claude Code, Codex, Copilot CLI and OpenCode. Use when the user wants to pair or mob on a session, share their AI session with colleagues, collaborate on prompts, add teammates to what they are working on, or set up group review of prompts and tool calls.
---

# Multiplayer AI sessions

`multiplayer-cli` turns one AI session into a room several people share. Every
participant sees the same transcript; nothing reaches the model until the room's
policy is satisfied.

## Starting a room

Check the tool is present (`mpx --version`); if not, `npm install -g multiplayer-cli`.

```bash
mpx host --backend claude-code --cwd .
```

Pick the backend from whatever the user already uses: `claude-code`, `codex`,
`copilot`, `opencode`, or `anthropic` (Claude via the API, and the only backend
where the room also votes on the model's tool calls). `mpx backends` lists them.
Only the host needs the CLI installed and the credentials.

Then give the user the `mpx join …` line it prints, verbatim, so they can pass it
to their teammates. Do not paste the join token into anything shared more
broadly than the people they name — it is a bearer secret.

Pick the policy from how many people and how much risk:

- two or three people, ordinary work → `--policy pair`
- a working group → `--policy team` (the default)
- production, or an audience the user does not fully know → `--policy strict`
- a demo where the user drives → `--policy host`

## Joining someone else's room

```bash
mpx join ws://host:7777/?t=TOKEN --name <their name>
```

Add `--observer` for a read-only seat.

## Reaching teammates who are not on the same network

Default bind is `127.0.0.1`. Options, in the order worth suggesting:

1. A relay, if the user has any box the team can reach — no inbound port on the
   host at all:
   ```bash
   mpx relay --port 7788                       # once, on that box
   mpx host --relay wss://relay.example.com    # on the host
   ```
   Say plainly that the relay carries session content in the clear, so it should
   be theirs and behind TLS. It never gets the room token and cannot admit
   anyone the host would refuse.
2. An SSH tunnel they already trust: `ssh -R 7777:localhost:7777 user@host`.
3. `--host 0.0.0.0` on a trusted LAN.

## In the session

Bare text is a proposal, not a message. `/y` approves, `/n <reason>` vetoes,
`/amend` rewrites (clearing votes), `/say` talks to the room without spending a
turn, `/stop` interrupts. `/help` lists everything.

## Reviewing afterwards

Each room writes `.mpx/<room>.jsonl` — who proposed, who approved, who vetoed
and why.

```bash
mpx transcript .mpx/<room>.jsonl --votes
```

## Riding a session that already exists

`--resume <id>` continues a session the backend already has. `--attach <url>`
points OpenCode at a running `opencode serve` that other clients may already be
on, so the room joins an existing shared session instead of starting one.

If a CLI's flags have drifted, `--backend-bin` and the repeatable
`--backend-arg` fix it from the command line.

## Notes worth passing on

- Only the host needs model credentials, and only the host needs the coding CLI.
- The room always votes on what gets **sent**. Only the `anthropic` and `echo`
  backends also vote on the model's **tool calls** — the other CLIs run their
  own agent loops and enforce their own permissions.
- Tools run on the **host's** machine in `--cwd`; everyone in the room can
  propose work that touches it. Reads are auto-allowed, writes and shell
  commands go to a vote. `--policy strict` puts every one of them to a
  unanimous vote.
- `--backend echo` is a full dry run with no key and no spend — use it to show
  someone how the room works before doing anything real.
