# Documentation

## Which are you?

| | |
|---|---|
| **Somebody sent me a link** | → **[Start here](./joining.md)** — no technical knowledge needed, nothing to install |
| **I want to run a session** | → [Getting started](./getting-started.md) — about five minutes |
| **I'm looking for a specific setting** | → the reading path below |

## What this is, in plain English

One person opens an AI assistant on their computer — the kind that helps write
software. Normally only they can talk to it.

This tool lets them share it. Other people join with a link and can see
everything the AI says, suggest what to ask it next, and vote on those
suggestions. **Nothing is sent to the AI until the group agrees.**

That is the whole idea. Everything else on this page is detail.

## The words we use

Six terms cover almost everything. The rest of the docs assume these.

| Term | What it means |
|---|---|
| **Room** | One shared session. It has a name, a link, and a set of rules. |
| **Host** | The person who ran `mpx share`. The session runs on their machine and their account. |
| **Seat** | Anyone else in the room. Seats propose and vote; they never talk to the model directly. |
| **Proposal** | A line you typed. It gets a number (`#4`) and waits for votes instead of going straight to the model. |
| **Gate** | The rule that decides whether a proposal passes — majority, unanimous, host-decides, and so on. |
| **Backend** | The AI CLI actually running the session: Claude Code, Codex, Copilot, Gemini, and others. |

Three more show up once you go past the basics:

| Term | What it means |
|---|---|
| **Lane** | One of several agents working in parallel, each on its own git branch. |
| **Crossroads** | The agent stopping to ask the room which of two directions to take. |
| **Relay** | A middleman server, for when your teammates cannot reach your machine directly. |

## Reading path

**0 · If you were invited**

- [Someone sent you a link](./joining.md) — the non-technical guide; nothing to install

**1 · Get a room running**

- [Getting started](./getting-started.md) — install, share a link, take a turn
- [The terminal seat](./the-screen.md) — the panes, the keys, and when it uses one column

**2 · Set the rules**

- [Deciding together](./deciding.md) — the six presets, and how to tune them
- [Backends](./backends.md) — which AI CLI runs the session, and how to add one

**3 · Get your team in**

- [Reaching your team](./relay.md) — same network, relay, or tunnel
- [Security model](./security.md) — what the link protects, and what it does not

**4 · Work in parallel** *(optional; a room works fine without any of it)*

- [Racing](./racing.md) — try one prompt several ways, vote on the diffs
- [Splitting](./splitting.md) — different work at once, each landing on its own
- [Crossroads](./crossroads.md) — let the agent ask the room which way to go

**5 · Other ways to take a seat**

- [The editor seat](./editor.md) — the VS Code / Cursor extension
- [Driving it from an agent](./agents.md) — the Claude Code plugin and Gemini extension

**Reference**

- [Protocol](./protocol.md) — the wire format, for building your own client
- [Account pooling](./pooling.md) — spreading turns across accounts (experimental)

## Common questions

**Does everyone need an API key?** No. Only the host needs a coding CLI they are
signed into. Everyone else joins with a link and needs nothing.

**Can non-technical people take part?** Yes, and that is a normal way to use it.
Someone who was sent a link clicks it, types their name, and reads and votes in
their browser — no terminal, no install, no account. Point them at
[Someone sent you a link](./joining.md).

**Does everyone need to install it?** No. Seats can join from a browser with
nothing installed.

**Can I try it without spending anything?** Yes — `--backend echo` runs a real
room on an offline stand-in. No key, no model, no cost.

**Where does the code run?** On the host's machine, in the host's checkout. The
room decides *what* is sent; the host's computer is what runs it.

**Is anything recorded?** Yes. Every room writes `.mpx/<room>.jsonl` — who
proposed what, who approved, who vetoed and why. Replay it with
`mpx transcript`, or turn it off with `--no-transcript`.
