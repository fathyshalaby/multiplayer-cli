# Changelog

## 0.6.0

Sessions now cross the internet safely.

- **End-to-end encryption with forward secrecy.** Each connection agrees a key
  by ephemeral ECDH (P-256), authenticated with the room token and salted by
  both sides' nonces; traffic is sealed with AES-256-GCM under that key. The
  token authenticates the exchange but never encrypts anything, so a recording
  made today stays unreadable even if the link leaks tomorrow.
- **The token never travels.** It was previously sent as `?t=` in the
  WebSocket URL, which meant a relay operator learned the room's password.
  Authentication is now decryption: a seat proves it belongs by producing a
  frame the room can open.
- **TLS without a reverse proxy** — `--tls-cert` / `--tls-key` on both
  `mpx relay` and `mpx share`.
- **`mpx join` refuses plaintext to a public address** when a room has no token
  and therefore no encryption. Override with `--insecure`.
- A socket that connects without proving itself is dropped after ten seconds
  rather than held open.
- The browser seat encrypts too, via WebCrypto. Browsers only expose that in a
  secure context, so it needs `https` (or `localhost`) and says so plainly
  instead of downgrading.
- Protocol version 2. A v1 client cannot talk to a v2 room.

## 0.5.1

- Relicensed to **MIT**. The previous release shipped PolyForm Noncommercial;
  this drops the noncommercial restriction entirely, so commercial use needs no
  permission. Attribution is the only condition, and there is still no warranty
  or liability.

## 0.5.0

- Account pooling is now **experimental and opt-in** on both sides — `--pool` on
  the host, `--runner` on a seat. Without them, every turn runs on the host's
  account and the room says nothing about runners at all.
- `--help` is two tiers: the few lines almost everyone needs, and
  `mpx help --all` for the rest.
- Licensed under PolyForm Noncommercial 1.0.0 (superseded by MIT in 0.5.1).
- Full documentation under [`docs/`](./docs).

## 0.4.0

- Turns can run on other people's subscriptions. The room stays on one account
  while it works and hands the session over when one reports a usage limit,
  carrying the conversation across itself.
- `limits.ts` separates "this account is spent" from "this is broken", and reads
  a reset time out of the message when the tool gives one.
- Runners are listed with their own working directories, since tools act on the
  runner's checkout rather than the host's.

## 0.3.0

- `mpx share`: one command, auto-detected backend, and a link to send.
- A **browser seat** served at `/s/<room>` by the host or the relay — read,
  propose, vote and veto with nothing installed.
- The share token moved into the URL fragment, so it never reaches a server as
  part of an HTTP request.
- `mpx join` accepts the share link, the raw WebSocket URL, or a bare host:port.

## 0.2.0

- Backends for **Codex**, **GitHub Copilot CLI** and **OpenCode**, alongside
  Claude Code. Each is a small profile over a shared process driver.
- `--backend-bin` and `--backend-arg` to repair a drifted CLI from the command
  line.
- `--resume` and `--attach` to ride a session that already exists.
- **Relay**: the host dials out, so no inbound port is needed anywhere.

## 0.1.0

- First release. A room server owning one AI session, terminal seats over
  WebSockets, and a consent gate between the two.
- Six decision modes, six presets, lazy-consensus timers, veto with a recorded
  reason, amendments that clear votes.
- The model's tool calls go through the same gate.
- A JSONL audit log of every proposal, vote and veto, replayable with
  `mpx transcript`.
