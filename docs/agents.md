# Driving it from an agent

*Installing mpx into Claude Code, Gemini CLI, or any other agent that can run a command.*

`mpx` is a CLI, so any agent that can run a command can start a room. What the
integrations here add is that the agent knows *when* to, and hands the link over
without mangling it.

There are three, and they are the same content in three packagings — the skill
is the source, and the rest is generated or checked against it. Cursor reads a
short rule that points at that same flow, so a Cursor agent in this checkout
already knows when to share.

## Claude Code

The repository is a plugin marketplace:

```
/plugin marketplace add fathyshalaby/multiplayer-cli
/plugin install multiplayer@multiplayer-cli
```

The skill also ships inside the package itself, so installing it
(`npm install -g github:fathyshalaby/multiplayer-cli`) puts the skill on disk
whether or not you install the plugin.

## Gemini CLI

```
gemini extensions install https://github.com/fathyshalaby/multiplayer-cli
```

It adds `/share` and `/join`, and a context file so the model knows what a room
is before you ask. Gemini is also a backend (`--backend gemini`), so a room can
be hosted on it as well as started from it — though it starts a fresh session
each turn, which the room says out loud rather than pretending otherwise.

## Cursor

This repository ships `.cursor/rules/multiplayer.mdc`. A Cursor agent — including
a Cloud Agent working in this checkout — is told to run `mpx share` when someone
asks to pair or invite teammates, and to hand the link over **verbatim**.

That only covers *this* repo. To have Cursor offer the same thing in any
project, put the skill where Cursor looks for user skills — the same file
Claude Code reads, not a copy:

```
mkdir -p ~/.cursor/skills
cp -r skills/multiplayer ~/.cursor/skills/
```

The rule is short on purpose and points at `skills/multiplayer/SKILL.md` for
relay, policy, racing and splitting.

The editor extension is a separate seat — same protocol, a panel instead of a
terminal. **Share this folder as a session** starts the room from the command
palette. See [The editor seat](./editor.md).

## Anything else

Any agent that reads a project file will do fine with the skill's text pasted
into `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/` or whatever that tool reads. It
is deliberately short and has no Claude-specific instructions in the body —
only the YAML frontmatter is Claude Code's.

## What the agent is told

Two things matter more than the rest, and both are in there because getting
them wrong is expensive:

**Hand the link over verbatim.** The fragment after `#` is the room key. An
agent that "helpfully" shortens a link breaks it; an agent that pastes it
somewhere has given that somewhere a seat.

**Do not recite the feature list.** The skill leads with `mpx share` and a link.
Racing, splitting and previews are further down, under the conditions that make
them worth reaching for. A room works without any of them, and a first
conversation that opens with a menu teaches nobody anything. There is a test
asserting they appear *after* the link rather than before it.

## Keeping them in step

The same number and the same prose in several files is how `mpx --version` came
to lie for two releases, and how the editor extension came to offer seven of the
eleven backends.

So `skills/multiplayer/SKILL.md` is the only copy anyone edits. Gemini's
`GEMINI.md` is generated from it, and the plugin, the editor extension and the
Gemini extension all take their version from `package.json`:

```bash
npm run sync           # write them
npm run sync -- --check   # verify, which is what CI runs
```

A stale copy fails the build. Tests also assert that every backend the CLI has
is named in the skill, that the marketplace points at a plugin that exists, and
that the three versions match.

---

[← All documentation](./README.md)
