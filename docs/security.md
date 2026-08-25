# Security model

What this protects, and what it does not. Read this before putting a room on
anything that matters.

## Room traffic is end-to-end encrypted

The token in a share link is not a password sent to a server — it is the key.

Every frame between a seat and the host is sealed with AES-256-GCM under a key
derived from the token (HKDF-SHA256, salted with the room name). Anything in
between — a relay, a TLS terminator, a corporate proxy, whoever runs the box —
moves ciphertext it cannot read.

**The token itself never travels.** There is nothing on the wire to intercept
and nothing for an access log to capture. A seat proves it belongs by producing
a frame the room can decrypt; a wrong token, a tampered frame and a replayed one
all fail identically, and all mean the same thing.

What is *not* hidden is metadata: who connects, when, how much they say, and the
room name. Put TLS in front if that matters — `mpx relay --tls-cert/--tls-key`,
or a terminator you already trust.

## The link is still a bearer secret

Anyone holding the link can join and decrypt everything. Treat it like a
password.

- It lives in the URL **fragment** (`#t=…`), which browsers never send to a
  server, so it stays out of access logs, proxy history and `Referer` headers.
- It is **not** rotated, and there is no revocation short of restarting the room
  with a new one.
- `--open` creates a room with no token — and therefore **no encryption**. Fine
  on a network you trust for five minutes; `mpx join` refuses to connect to one
  at a non-local address unless you pass `--insecure`.

## The browser seat needs https

Browsers only expose the cryptography for this in a *secure context*. Over
`https://` or `localhost` the browser seat encrypts exactly like a terminal
seat. Over plain `http://` on a LAN address it cannot, so it says so and asks
you to use https or join from a terminal, rather than quietly downgrading a room
that is supposed to be encrypted.

This is the main reason to give a relay a certificate.

## What the room can reach

Tools run on the **host's** machine, in `--cwd`. Paths that escape that
directory are refused, but everything inside it is fair game for whatever the
room approves — and everyone with the link can propose.

The gate is the real control:

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

A relay forwards sealed frames and a channel number. It never receives the
token, cannot read a session, cannot admit anyone the host would refuse, and
cannot alter a frame without the receiver rejecting it. Running someone else's
relay costs you traffic metadata and nothing else.

It rate-limits connection attempts it cannot authenticate, and a socket that
connects without proving itself within ten seconds is dropped rather than held
open.

## What is recorded

Unless you pass `--no-transcript`, every room writes `.mpx/<room>.jsonl`
containing proposals, votes, veto reasons, chat and model output — in plain
text, on the host's disk. It is an audit log by design; treat it as one. The
encryption protects the wire, not the disk.

## What this does not do

- **No forward secrecy.** One key for the life of the room, derived from the
  token. Someone who records traffic and later obtains the link can read what
  they recorded.
- **No per-seat identity.** Everyone with the link shares one key, so the
  cryptography proves someone is *in the room*, not *which person they are*.
  Display names are claimed, not verified.
- **No protection from the host.** The host runs the session and sees
  everything. That is the design.
- **Not audited.** Standard constructions used in a straightforward way, but no
  third party has reviewed this.

## Reporting something

Open an issue at
<https://github.com/fathyshalaby/multiplayer-cli/issues>. If it is sensitive,
say so without the details and the maintainer will find a private channel.
