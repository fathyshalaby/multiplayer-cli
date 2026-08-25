import type { CliProfile, ProfileSink, TurnContext } from "./process.js";

/**
 * How each coding CLI is driven.
 *
 * The shapes differ more than the marketing does. Codex emits a documented
 * JSONL event stream and resumes by thread id. Copilot prints plain text and
 * has no machine-readable mode at all. OpenCode has both, plus a server other
 * clients can already attach to. Each profile encodes exactly that, and
 * nothing is assumed beyond what the tool documents.
 *
 * Flags drift. `--backend-bin` and `--backend-arg` exist so a room can be
 * repaired from the command line rather than waiting on a release here.
 */

/* ------------------------------------------------------------------ */
/* Codex — JSONL events, resume by thread id                           */
/* ------------------------------------------------------------------ */

export const codex: CliProfile = {
  name: "codex",
  bin: "codex",
  parse: "jsonl",
  promptVia: "arg",
  resumable: true,
  install: "install it with `npm i -g @openai/codex`",
  args(ctx: TurnContext): string[] {
    const base = ["exec"];
    // `codex exec resume <thread_id>` continues the same thread, which is what
    // makes the room's turns one conversation instead of many.
    if (ctx.sessionId) base.push("resume", ctx.sessionId);
    base.push("--json", "--skip-git-repo-check", "-C", ctx.cwd);
    if (ctx.model) base.push("-m", ctx.model);
    base.push(...ctx.extraArgs);
    base.push(ctx.prompt);
    return base;
  },
  onEvent(ev: any, sink: ProfileSink): void {
    switch (ev?.type) {
      case "thread.started":
        if (typeof ev.thread_id === "string") sink.session(ev.thread_id);
        return;
      case "turn.started":
        return;
      case "item.completed":
      case "item.updated": {
        const item = ev.item ?? {};
        switch (item.type) {
          case "agent_message":
            if (ev.type === "item.completed" && item.text) sink.text(item.text + "\n");
            return;
          case "reasoning":
            if (ev.type === "item.completed" && item.text) sink.thinking(item.text);
            return;
          case "command_execution":
            sink.tool(item.id ?? "", `run: ${firstLine(item.command ?? item.text ?? "")}`);
            return;
          case "file_change":
            sink.tool(item.id ?? "", `edit: ${describeChanges(item)}`);
            return;
          case "mcp_tool_call":
            sink.tool(item.id ?? "", `mcp: ${item.server ?? ""}/${item.tool ?? ""}`);
            return;
          case "web_search":
            sink.tool(item.id ?? "", `search: ${firstLine(item.query ?? "")}`);
            return;
          case "todo_list":
            return;
          default:
            return;
        }
      }
      case "turn.completed":
        if (ev.usage) {
          sink.usage({
            input_tokens: num(ev.usage.input_tokens),
            output_tokens: num(ev.usage.output_tokens),
            ...(ev.usage.cached_input_tokens ? { cache_read: num(ev.usage.cached_input_tokens) } : {}),
          });
        }
        sink.done("end_turn");
        return;
      case "turn.failed":
        sink.done("error", ev.error?.message ?? "the turn failed");
        return;
      case "error":
        sink.done("error", ev.message ?? "codex reported an error");
        return;
    }
  },
};

/* ------------------------------------------------------------------ */
/* GitHub Copilot CLI — plain text, no structured mode                 */
/* ------------------------------------------------------------------ */

export const copilot: CliProfile = {
  name: "copilot",
  bin: "copilot",
  parse: "text",
  promptVia: "arg",
  resumable: true,
  install: "install it with `npm i -g @github/copilot`",
  args(ctx: TurnContext): string[] {
    // `-s` drops the stats and decoration so the room sees the answer only.
    const base = ["-p", ctx.prompt, "-s", "--no-ask-user"];
    if (ctx.sessionId) base.push("--resume", ctx.sessionId);
    if (ctx.model) base.push(`--model=${ctx.model}`);
    base.push(`--add-dir=${ctx.cwd}`);
    base.push(...ctx.extraArgs);
    return base;
  },
};

/* ------------------------------------------------------------------ */
/* OpenCode — text by default; can attach to a running server          */
/* ------------------------------------------------------------------ */

export const opencode: CliProfile = {
  name: "opencode",
  bin: "opencode",
  parse: "text",
  promptVia: "arg",
  resumable: true,
  install: "install it from https://opencode.ai",
  args(ctx: TurnContext): string[] {
    const base = ["run"];
    if (ctx.sessionId) base.push("--session", ctx.sessionId);
    if (ctx.model) base.push("--model", ctx.model);
    base.push(...ctx.extraArgs);
    base.push(ctx.prompt);
    return base;
  },
};

/**
 * The same tool in its structured mode.
 *
 * OpenCode's `--format json` emits its internal bus events, whose shapes are
 * not pinned by a published schema, so the mapper reads defensively and the
 * plain-text profile above stays the default.
 */
export const opencodeJson: CliProfile = {
  ...opencode,
  name: "opencode-json",
  parse: "jsonl",
  args(ctx: TurnContext): string[] {
    const base = ["run", "--format", "json"];
    if (ctx.sessionId) base.push("--session", ctx.sessionId);
    if (ctx.model) base.push("--model", ctx.model);
    base.push(...ctx.extraArgs);
    base.push(ctx.prompt);
    return base;
  },
  onEvent(ev: any, sink: ProfileSink): void {
    const type: string = ev?.type ?? "";
    const props = ev?.properties ?? ev;

    if (type.startsWith("session.") && typeof props?.info?.id === "string") {
      sink.session(props.info.id);
    }
    if (typeof props?.sessionID === "string") sink.session(props.sessionID);

    // Text arrives either as an incremental delta or as a whole updated part.
    if (type === "message.part.delta" && typeof props?.text === "string") {
      sink.text(props.text);
      return;
    }
    if (type === "message.part.updated") {
      const part = props?.part ?? props;
      if (part?.type === "text" && typeof part.text === "string") {
        sink.text(part.text);
        return;
      }
      if (part?.type === "reasoning" && typeof part.text === "string") {
        sink.thinking(part.text);
        return;
      }
      if (part?.type === "tool") {
        const name = part.tool ?? part.name ?? "tool";
        sink.tool(String(part.id ?? part.callID ?? ""), `${name}`);
        return;
      }
    }
    if (type === "session.idle" || type === "session.completed") {
      sink.done("end_turn");
      return;
    }
    if (type === "session.error" || type === "error") {
      sink.done("error", props?.message ?? "opencode reported an error");
    }
  },
};

export const PROFILES: Record<string, CliProfile> = {
  codex: codex,
  copilot: copilot,
  opencode: opencode,
  "opencode-json": opencodeJson,
};

function firstLine(s: unknown): string {
  return String(s ?? "").split("\n")[0]!.slice(0, 160);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function describeChanges(item: any): string {
  const changes = item?.changes;
  if (Array.isArray(changes) && changes.length) {
    const names = changes.map((c: any) => c?.path ?? c?.file).filter(Boolean);
    if (names.length) return names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "");
  }
  return firstLine(item?.path ?? item?.text ?? "files");
}
