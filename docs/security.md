# Security model

What this protects, and what it does not. Read this before putting a room on
anything that matters.

## In short

| | |
|---|---|
| **Traffic** | End-to-end encrypted. A relay or proxy in the path moves ciphertext it cannot read. |
| **The token** | Never sent over the network. It authenticates a key agreement rather than being the key. |
| **A leaked link** | Cannot decrypt traffic recorded earlier — but lets the holder join from then on. |
| **The link itself** | A bearer secret. Treat it like a password. |
| **The host** | Sees everything and runs everything. That is the design. |
| **Audited?** | No. |

## How the encryption works

The token in a share link is not a password sent to a server, and it is not the
encryption key either. It **authenticates a key agreement**.

Every connection begins with an ephemeral ECDH exchange (P-256), MAC'd on both
sides with a key derived from the token, with both sides' nonces mixed in.
Traffic is then sealed with AES-256-GCM under *that* key.

Two consequences:

- **Forward secrecy.** The key comes from ephemeral halves that never leave
  memory and are gone when the connection ends, so someone who records traffic
  today and obtains the link tomorrow still cannot read the recording. Two
  connections to the same room with the same token produce unrelated keys.
- **Nothing to intercept.** The token never travels, so there is nothing on the
  wire to capture and nothing for an access log to keep. A seat proves it belongs
  by producing a frame the room can decrypt; a wrong token, a tampered frame and
  a replayed one all fail identically.

What is *not* hidden is metadata: who connects, when, how much they say, and the
room name. Put TLS in front if that matters.

## The link is a bearer secret

Anyone holding the link can join and decrypt everything.

- It lives in the URL **fragment** (`#t=…`), which browsers never send to a
  server, so it stays out of access logs, proxy history and `Referer` headers.
- It is **not rotated**, and there is no revocation short of restarting the room
  with a new one.
- `--open` creates a room with no token — and therefore **no encryption**. Fine
  on a network you trust for five minutes; `mpx join` refuses to connect to one
  at a non-local address unless you pass `--insecure`.

## The browser seat needs https

Browsers only expose the necessary cryptography in a *secure context*. Over
`https://` or `localhost` the browser seat encrypts exactly like a terminal seat.

Over plain `http://` on a LAN address it cannot, so it says so and asks you to
use https or join from a terminal — rather than quietly downgrading a room that
is supposed to be encrypted. This is the main reason to give a relay a
certificate.

## What the room can reach

Tools run on the **host's** machine, in `--cwd`. Paths that escape that directory
are refused, but everything inside it is fair game for whatever the room
approves — and everyone with the link can propose.

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

## What is recorded

Unless you pass `--no-transcript`, every room writes `.mpx/<room>.jsonl`
containing proposals, votes, veto reasons, chat and model output — in plain text,
on the host's disk. It is an audit log by design; treat it as one. The encryption
protects the wire, not the disk.

## What this does not do

- **No in-session rekeying.** One key per *connection*, not rotated during it.
  Reconnecting agrees a new one. An attacker who extracts a live session key from
  process memory can read the rest of that connection — but they already had the
  machine at that point.
- **No per-seat identity.** Everyone with the link shares one key, so the
  cryptography proves someone is *in the room*, not *which person they are*.
  Display names are claimed, not verified.
- **No protection from the host.** The host runs the session and sees everything.
- **No protection from an active attacker who already has the link.** The token
  authenticates the handshake, so anyone holding it can be a legitimate party —
  including in the middle. The link is the trust boundary.
- **Not audited.** Standard constructions used in a straightforward way
  (HKDF-SHA256, ECDH P-256, HMAC-SHA256, AES-256-GCM), but no third party has
  reviewed this.

## Reporting something

Open an issue at
<https://github.com/fathyshalaby/multiplayer-cli/issues>. If it is sensitive, say
so without the details and the maintainer will find a private channel.

---

## Appendix: why finishing the handshake proves nothing

*Implementation detail, for anyone reading the crypto.*

Completing the key agreement is not proof of anything. The client's half of the
handshake is a MAC over its own public key and nonce — nothing in it is chosen by
the connection it arrives on, so a captured opening frame replays perfectly.

The replayer cannot go any further: it has no private half, so it can never
produce a frame that opens under the agreed key. But if finishing the handshake
were enough, it could hold a socket open indefinitely. Repeat that and a room
fills with connections that can never say anything, which is a way to keep other
people out.

So the clock only stops when a frame arrives that **decrypts**. A real seat sends
`hello` the moment it has a key, so it is proven in milliseconds; anything else
is dropped after ten seconds.

---

[← All documentation](./README.md)
