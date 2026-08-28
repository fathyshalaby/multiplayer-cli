# The editor seat

*The VS Code / Cursor extension: the same seat as a terminal, in a panel.*

A room has three kinds of seat: a terminal (`mpx join`), a browser (open the
link), and an editor. They are the same participant to the room — same protocol,
same encryption, same votes.

## Install

Works in **VS Code, Cursor, VSCodium and Windsurf**. This breadth is the point:
Live Share is licensed to official Microsoft builds and has been blocked in
forks since 2025, so a Cursor user has had no equivalent.

It is not on a registry yet. Install the `.vsix` — either the one CI attaches
to every run, or one you build:

```bash
npm run build:extension
cd extension && npx vsce package --no-dependencies --out multiplayer-cli.vsix
cursor --install-extension multiplayer-cli.vsix   # or code / codium / windsurf
```

When it is published it will go to **Open VSX**, which is the registry those
editors actually use.

## What it does

**Share this folder as a session** starts a room on whichever coding CLI you
have, using the open folder as the working directory, and copies an invite link.
No terminal involved.

**Join a session** takes a link someone sent you.

The panel in the activity bar shows the roster, anything awaiting a decision
with Approve and Veto on it, and the model's reply as it streams. The status bar
says what is waiting on you.

| | |
|---|---|
| `Ctrl/Cmd+Alt+P` | propose |
| `Ctrl/Cmd+Alt+Y` | approve |
| `Ctrl/Cmd+Alt+N` | veto, with a reason |

## Settings

| Setting | What it does |
|---|---|
| `multiplayer.backend` | which coding CLI runs the session; empty means detect one |
| `multiplayer.policy` | the room's decision preset |
| `multiplayer.relay` | a relay to serve through, so teammates need no route to you |
| `multiplayer.lanes` | parallel worktrees a bare `/race` opens; 0 turns [racing](./racing.md) off |
| `multiplayer.laneSetup` | a command run in each lane's fresh checkout, e.g. `npm ci` |

## How it is put together

The **extension host owns the connection**. It imports the same client,
protocol and crypto the terminal uses, so an editor seat is not a
reimplementation — it is the same code with a different view.

The **webview is only a view**. It receives state and posts back what was
clicked; it never opens a socket and never holds a key. Besides being the
standard VS Code shape, this sidesteps the rule that browsers only expose
WebCrypto in a secure context — a constraint the browser seat does have to
live with.

The interesting logic — accumulating a streamed reply, ordering proposals,
knowing which one a bare "approve" means — lives in `src/client/roomView.ts`,
outside the extension entirely, so it is tested without an editor. The built
bundle is also loaded in a test against a stubbed editor API, because that is
the only way to catch a module that throws on import.

## Limitations

- **One session at a time** per window.
- **No editor integration beyond the panel.** It does not show cursors, share
  a terminal, or apply edits — the AI acts on the host's machine as it always
  has. This is a seat, not a Live Share replacement.
- **Hosting needs an open folder**, since a session needs a working directory.
- **Racing needs that folder to be a git repository**, since lanes are branches.
  The room says so rather than failing when somebody types `/race`.

---

[← All documentation](./README.md)
