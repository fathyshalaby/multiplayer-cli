# Backends

A backend is the AI that a room's session runs on. Bring whichever coding CLI
your team already uses — the room's job is the same in every case.

```bash
mpx backends     # what you have installed, and what `mpx share` would pick
```

| `--backend` | Session model | Streaming | Room votes on tool calls |
|---|---|---|---|
| `anthropic` | a Claude conversation owned by the room | per-token | **yes** |
| `claude-code` | one long-lived `claude` process | per-token | no |
| `codex` | `codex exec --json`, resuming the thread each turn | per item | no |
| `copilot` | `copilot -p`, resuming the session each turn | raw stdout | no |
| `opencode` | `opencode run`, resuming the session each turn | raw stdout | no |
| `opencode-json` | the same with `--format json` | per event | no |
| `echo` | offline stand-in — no key, no spend | per-token | **yes** |

With no `--backend`, `mpx share` picks whichever CLI it finds on your PATH, in
that order, falling back to `ANTHROPIC_API_KEY` and then to `echo`.

### `anthropic` needs one extra package

Every other backend runs on a coding CLI you are already signed into, so
nothing else is needed. The `anthropic` backend talks to the API directly, and
its SDK is 12MB — too much to put in front of every install for the one backend
most rooms never use. It is an optional peer dependency:

```bash
npm install -g @anthropic-ai/sdk
```

Selecting `--backend anthropic` without it gives you that command rather than a
stack trace. The editor extension does not bundle it at all, and does not offer
the backend.

## The one limitation worth knowing

Every backend gates what the room **sends**. Only `anthropic` and `echo` also
put the model's own **tool calls** to a vote, because those are the two where
mpx owns the agent loop and can pause between `tool_use` and execution.

The other CLIs run their own loops and never ask us, so their own permission
systems apply. Pair them with the flags they already have:

```bash
mpx share --backend claude-code --permission-mode acceptEdits
mpx share --backend codex   --backend-arg --sandbox --backend-arg workspace-write
mpx share --backend copilot --backend-arg --deny-tool --backend-arg shell
```

## These CLIs move fast

Flags change between releases. Two escape hatches mean a drifted tool is a
command-line fix, not a version bump here:

```bash
mpx share --backend codex \
          --backend-bin /opt/bin/codex \
          --backend-arg --sandbox --backend-arg workspace-write
```

- `--backend-bin` picks the binary.
- `--backend-arg` is repeatable and appended **last**, so it overrides whatever
  the built-in profile constructed.

## Pointing at a session that already exists

```bash
mpx share --backend claude-code --resume 8f3a…      # a Claude Code session
mpx share --backend codex       --resume th_abc123  # a Codex thread
```

`--resume` takes whatever that tool calls a session or thread id. mpx also
captures the id from the first turn and reuses it on every turn after, so a
room is one conversation rather than a series of unrelated ones.

OpenCode's server already accepts several clients on one session, so a room can
sit on top of it rather than starting a rival one:

```bash
opencode serve --port 4096
mpx share --backend opencode --attach http://localhost:4096
```

## Adding another CLI

A backend is a *profile*, not a class — `src/agent/profiles.ts`:

```ts
export const yourtool: CliProfile = {
  name: "yourtool",
  bin: "yourtool",
  parse: "jsonl",          // or "text" to stream raw stdout
  promptVia: "arg",
  resumable: true,
  install: "install it with `npm i -g yourtool`",
  args(ctx) {
    const a = ["run"];
    if (ctx.sessionId) a.push("--session", ctx.sessionId);
    a.push(...ctx.extraArgs, ctx.prompt);
    return a;
  },
  onEvent(ev, sink) {
    if (ev.type === "text") sink.text(ev.text);
    if (ev.type === "done") sink.done("end_turn");
  },
};
```

`ProcessBackend` handles spawning, streaming, interrupts, exit codes and error
reporting. Profiles are tested against stub binaries that emit exactly what the
real tool documents, so a new one can be covered without installing it.
