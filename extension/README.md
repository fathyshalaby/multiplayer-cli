# multiplayer — for VS Code, Cursor, VSCodium and Windsurf

Share one AI session with your team, from inside your editor. Everyone sees the
same transcript, and **nothing is sent to the model until the room agrees**.

This is a seat in a [multiplayer-cli](https://github.com/fathyshalaby/multiplayer-cli)
room, alongside the terminal client and the browser seat. It speaks the same
protocol and the same end-to-end encryption.

## Why this exists

Live Share is licensed to official Microsoft builds only, and since 2025 has
been actively blocked in VS Code forks — so Cursor, VSCodium and Windsurf cannot
use it. This ships on Open VSX and works in all of them.

It also does a different thing. Live Share shares a keyboard. This shares a
*decision*: what the AI is asked, and whether it may act.

## Use it

- **multiplayer: Share this folder as a session** — starts a room on whichever
  coding CLI you have (Claude Code, Codex, Copilot CLI, OpenCode) and copies an
  invite link to your clipboard.
- **multiplayer: Join a session** — paste a link someone sent you.

Then use the panel in the activity bar, or:

| | |
|---|---|
| `Ctrl/Cmd+Alt+P` | propose something to the room |
| `Ctrl/Cmd+Alt+Y` | approve what is pending |
| `Ctrl/Cmd+Alt+N` | veto it, with a reason |

Typing in the panel proposes. Prefix with `/say` to talk to the room without
spending a turn.

## Settings

| | |
|---|---|
| `multiplayer.backend` | which AI runs a session you host; empty detects |
| `multiplayer.policy` | `solo`, `pair`, `team`, `strict`, `host`, `round-robin` |
| `multiplayer.relay` | a relay to serve through, so teammates need no route to you |

## What to know

- Only the person hosting needs a coding CLI and credentials.
- Tools run on the **host's** machine, in the shared folder.
- Room traffic is end-to-end encrypted; the token in the invite link
  authenticates a key exchange and never travels.
- The extension host holds the connection and the keys. The panel is only a
  view, and never touches the network itself.

Full documentation: <https://github.com/fathyshalaby/multiplayer-cli>
