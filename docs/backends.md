# Backends

A backend is the AI that actually runs the session. Bring whichever coding CLI
your team already pays for — the room behaves the same either way.

```bash
mpx backends     # what you have installed, and what `mpx share` would pick
```

With no `--backend`, `mpx share` picks the first CLI it finds on your PATH,
falls back to `ANTHROPIC_API_KEY`, and finally to the offline `echo` stand-in.
You usually do not need to choose.

## What you can use

| `--backend` | Runs | Room votes on tool calls |
|---|---|---|
| `claude-code` | one long-lived `claude` process | no |
| `codex` | `codex exec --json` | no |
| `copilot` | `copilot -p` | no |
| `opencode` | `opencode run` | no |
| `opencode-json` | the same with `--format json` | no |
| `gemini` | `gemini -p` | no |
| `cursor` | `cursor-agent -p` | no |
| `aider` | `aider --message --yes-always` | no |
| `amp` | `amp -x` | no |
| `anthropic` | Claude via the API, owned by the room | **yes** |
| `echo` | offline stand-in — no key, no spend | **yes** |

## The one limitation worth knowing

Every backend gates what the room **sends**. Only `anthropic` and `echo` also
put the model's own **tool calls** to a vote.

The reason is structural: those are the two where mpx owns the agent loop and
can pause between the model asking for a tool and the tool running. The other
CLIs run their own loops and never ask us, so **their** permission systems apply
instead. Set those explicitly rather than trusting the default:

```bash
mpx share --backend claude-code --permission-mode acceptEdits
mpx share --backend codex   --backend-arg --sandbox --backend-arg workspace-write
mpx share --backend copilot --backend-arg --deny-tool --backend-arg shell
```

## Not every CLI can carry a conversation

`claude-code`, `codex` and `opencode-json` report a session or thread id, so mpx
captures it and resumes the same conversation every turn.

The plain-text ones have no id to capture, so each turn starts the tool fresh.
The room is still one conversation to the people in it, but not to the model.
A room says so at the start rather than letting you discover it:

```
  · aider starts a fresh session each turn — it cannot carry the conversation between them
```

To continue a session that already exists:

```bash
mpx share --backend claude-code --resume 8f3a…      # a Claude Code session
mpx share --backend codex       --resume th_abc123  # a Codex thread
```

OpenCode's server already accepts several clients on one session, so a room can
sit on top of it rather than starting a rival one:

```bash
opencode serve --port 4096
mpx share --backend opencode --attach http://localhost:4096
```

## `anthropic` needs one extra package

Every other backend runs on a CLI you are already signed into. The `anthropic`
backend talks to the API directly, and its SDK is 12MB — too much to put in
front of every install for the one backend most rooms never use. So it is
optional:

```bash
npm install -g @anthropic-ai/sdk
```

Selecting `--backend anthropic` without it gives you that command rather than a
stack trace. The editor extension does not bundle it at all, and does not offer
the backend.

## When a CLI changes its flags

These tools move fast, and a flag that drifted should be a command-line fix
rather than something you wait on a release here for:

```bash
mpx share --backend codex \
          --backend-bin /opt/bin/codex \
          --backend-arg --sandbox --backend-arg workspace-write
```

- `--backend-bin` picks the binary.
- `--backend-arg` is repeatable and appended **last**, so it overrides whatever
  the built-in profile constructed.

## Adding another CLI

A backend is a *profile*, not a class. Add one to `src/agent/profiles.ts`:

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
real tool documents, so you can cover a new one without installing it.

---

[← All documentation](./README.md)
