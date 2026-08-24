---
name: multiplayer
description: Start or join a shared multiplayer AI session with teammates using multiplayer-cli (mpx), where the group proposes and votes on what gets sent to the model. Use when the user wants to pair or mob on a session, share their AI session with colleagues, collaborate on prompts, add teammates to what they are working on, or set up group review of prompts and tool calls.
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

Default bind is `127.0.0.1`. Prefer forwarding over a tunnel the user already
trusts rather than binding to a public interface:

```bash
ssh -R 7777:localhost:7777 user@host
```

`--host 0.0.0.0` is fine on a trusted LAN.

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

## Notes worth passing on

- Only the host needs model credentials.
- Tools run on the **host's** machine in `--cwd`; everyone in the room can
  propose work that touches it. Reads are auto-allowed, writes and shell
  commands go to a vote. `--policy strict` puts every one of them to a
  unanimous vote.
- `--backend echo` is a full dry run with no key and no spend — use it to show
  someone how the room works before doing anything real.
