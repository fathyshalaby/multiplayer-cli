# Security model

What this protects, and what it does not. Read this before putting a room on
anything that matters.

## The short version

A room is **as trusted as the people you send the link to**. The token controls
who gets in; after that, everyone in the room can propose work that runs on the
host's machine, subject to the room's policy. Invite accordingly.

## The link is a bearer token

The token in the share link is the only credential. Anyone holding it can join.

- It lives in the URL **fragment** (`#t=…`), which browsers never send to a
  server — so it stays out of relay access logs, proxy history and `Referer`
  headers. `mpx join` moves it onto the WebSocket where the host checks it.
- The host compares it in constant time.
- It is **not** rotated, and there is no revocation short of restarting the
  room with a new one.
- Transport is plain `ws://` unless you put TLS in front. On a LAN that means
  anyone who can sniff the network can read the session and lift the token.

Treat the link like a password. Prefer a tunnel or a TLS-terminated relay over
binding to a public interface.

## What the room can reach

Tools run on the **host's** machine, in `--cwd`. Paths that escape that
directory are refused, but everything inside it is fair game for whatever the
room approves.

The gate is the real control here:

| | |
|---|---|
| `--policy strict` | every write and every shell command needs a unanimous vote |
| `--set autoAllow=none` | nothing is auto-approved, not even reads |
| `--backend echo` | nothing runs at all — a complete dry run |

On backends that run their own agent loop (`claude-code`, `codex`, `copilot`,
`opencode`) the room votes on prompts but **not** on tool calls; those obey that
tool's own permission system. Set it explicitly rather than relying on its
default — see [Backends](./backends.md).

## The relay

A relay forwards frames and nothing else. It never receives the room token,
cannot admit anyone the host would refuse, and cannot influence a vote. It does
carry session content in the clear, so run your own and terminate TLS in front
of it. See [Reaching your team](./relay.md).

## The browser seat

The page is served from the room's own origin, inlines everything, and declares
a Content-Security-Policy with `default-src 'none'` — it makes no external
requests. It stores only your display name, in `localStorage`.

## Account pooling (experimental)

With `--pool`, turns can run on other people's machines under their own logins.
Nobody's credentials move: every account runs only where it is logged in. But
tools then act on **that** person's checkout, not the host's. See
[Account pooling](./pooling.md).

## What is recorded

Unless you pass `--no-transcript`, every room writes `.mpx/<room>.jsonl`
containing proposals, votes, veto reasons, chat and model output — in plain
text, on the host's disk. It is an audit log by design; treat it as one.

## Reporting something

Open an issue at
<https://github.com/fathyshalaby/multiplayer-cli/issues>. If it is sensitive,
say so in the issue without the details and the maintainer will find a private
channel.
