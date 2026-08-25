# Reaching your team

`mpx share` binds to your local network, so anyone on the same wifi or VPN can
open the link. Three ways to change that.

## This machine only

```bash
mpx share --local
```

The link then works only on your own machine — useful for trying things out, or
paired with a tunnel you set up yourself.

## Anywhere, through a relay

The host dials **out** to a relay, so there is nothing to open or forward on
your side and no inbound port anywhere.

```bash
mpx relay --port 7788                       # once, on any box your team can reach
mpx share --relay wss://relay.example.com   # on the host — remembered from then on
```

A small VPS is plenty. `mpx relay` also serves the browser seat, so the link a
relayed room prints is clickable in exactly the same way.

### What the relay is, and is not

It is a dumb pipe. It multiplexes teammates onto the one connection the host
dialled out on, and that is all.

- It **never receives the room token.** Authentication is end-to-end: every seat
  still has to satisfy the host's own check, which happens through the pipe.
- It **cannot admit anyone** the host would refuse.
- It **cannot count a vote**, change a policy, or reach the host's filesystem.
- It **does see session content in the clear**, because it forwards the frames.

So: run your own, and put TLS in front of it. `mpx relay` speaks plain `ws://`
and is meant to sit behind Caddy, nginx, or any terminator you already trust.

```
relay.example.com {
    reverse_proxy 127.0.0.1:7788
}
```

Limits it enforces on its own: `--max-rooms`, `--max-peers` per room, and
`--joins-per-minute`. Since it cannot authenticate a joiner, it rate-limits what
it cannot check and lets the host reject the rest.

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

Anyone who can reach the port may join. Fine on a trusted LAN for five minutes;
not something to leave running.
