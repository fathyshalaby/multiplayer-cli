# Reaching your team

By default `mpx share` goes through the hosted relay at
`wss://mpx-relay.fly.dev`, so the link opens for anyone, wherever they are,
with nothing to forward on your side. The relay carries sealed frames it cannot
read ([what it can and cannot see](#what-the-relay-can-and-cannot-see)). If the
hosted relay is down, `share` says so and falls back to a link that works on
your own network.

## Which one do I need?

| Your situation | Use |
|---|---|
| People are in different places, and you want it to just work | nothing — this is the default |
| You would rather nothing left your network | `--lan` |
| Just trying it out on your own machine | `--local` |
| You want the relay to be yours, not ours | `--relay wss://your-relay` |
| You already have a jumpbox, Tailscale or ngrok | an SSH tunnel |
| A throwaway room on a network you fully trust | `--open` (no encryption) |

`MPX_RELAY` changes the default without a flag: a URL to use a different relay
every time, or `MPX_RELAY=off` for none, which is the line to put in a CI job or
a shell profile. A `--relay` on the command line still wins over it.

An `--open` room never goes through a relay you did not name. It has no token,
so it has no encryption, and the relay would see everything. It stays on your
network unless you pass `--relay` yourself.

## Your network only

```bash
mpx share --lan
```

Binds to your local network, so anyone on the same wifi or VPN can open the
link, and nothing goes through a relay. This was the default before 0.14.
A browser only allows the encryption a browser seat needs on `https` pages, so
on a plain `http://` network link, teammates may need the terminal command the
invite page offers instead.

## This machine only

```bash
mpx share --local
```

The link works only on your own machine. Useful for trying things out, or paired
with a tunnel you set up yourself.

## Anywhere, through a relay

The host dials **out** to a relay, so there is nothing to open or forward on your
side and no inbound port anywhere. The hosted one is the default. To run your
own:

```bash
mpx relay --port 7788                       # once, on any box your team can reach
mpx share --relay wss://relay.example.com   # on the host — remembered from then on
```

A small VPS is plenty. `mpx relay` also serves the browser seat, so a relayed
room's link is clickable in exactly the same way.

### What the relay can and cannot see

It is a dumb pipe. It multiplexes teammates onto the one connection the host
dialled out on, and that is all. Room traffic is sealed end-to-end *before* it
reaches the relay, so what passes through is ciphertext with a channel number.

- It **never receives the token** — there is none on the wire to receive.
- It **cannot read a session**, only move it.
- It **cannot admit anyone** the host would refuse, or alter a frame without the
  receiver rejecting it.
- It **does see metadata**: who is connected, when, how much they say, and the
  room name.

Running someone else's relay costs you that metadata and nothing else. Running
your own costs you a box.

### Give it a certificate

Two reasons. Metadata is one. The bigger one is that browsers only expose the
cryptography for end-to-end encryption in a secure context, so **a browser seat
needs `https`**.

```bash
mpx relay --port 443 --tls-cert /etc/letsencrypt/live/relay.example.com/fullchain.pem \
                     --tls-key  /etc/letsencrypt/live/relay.example.com/privkey.pem
```

Or terminate in front of it, if you already run something:

```
relay.example.com {
    reverse_proxy 127.0.0.1:7788
}
```

### Running one for real

```ini
# /etc/systemd/system/mpx-relay.service
[Unit]
Description=multiplayer-cli relay
After=network.target

[Service]
ExecStart=/usr/bin/mpx relay --port 7788 --host 127.0.0.1 --quiet
Restart=always
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Or skip writing a Dockerfile: every release publishes an image.

```bash
docker run -p 7788:7788 ghcr.io/fathyshalaby/multiplayer-cli \
  relay --port 7788 --host 0.0.0.0
```

The relay holds no state worth backing up: rooms live only as long as their
hosts are connected.

It enforces `--max-rooms`, `--max-peers` per room, `--joins-per-minute`, and
`--max-frame` (8 MiB, against a room frame measured in kilobytes — the
underlying library would otherwise accept 100 MiB from anyone who connects).
Since it cannot authenticate a joiner, it rate-limits what it cannot check and
lets the host reject the rest; a socket that connects and says nothing is
dropped after ten seconds.

### Seeing what is running

```bash
mpx relay --directory          # on the relay: publish the names it hosts
mpx rooms wss://relay.example.com
```

```
  design-review            2 seats   up 14m
  amber-ridge-04           1 seat    up 3m

  Names only — you still need the invite link to join one.
```

Off by default, because a room name is metadata: a relay that lists them tells
anyone who asks what your team is working on. Knowing a name grants nothing —
the host still has to be satisfied — but it is a disclosure, so it is a choice.

## An SSH tunnel

If you would rather run nothing:

```bash
ssh -R 7777:localhost:7777 you@jumpbox     # on the host
mpx join ws://127.0.0.1:7777/?t=…          # on the jumpbox
```

Tailscale, ngrok and friends work the same way.

## No token at all

```bash
mpx share --open
```

No token means **no key**, which means **no encryption**. Anyone who can reach
the port may join, and anyone on the path can read the session. `mpx join`
refuses to connect to an open room at a non-local address unless you pass
`--insecure`.

---

[← All documentation](./README.md)
