import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AgentBackend, AgentEvents, BackendOptions, TurnResult } from "./types.js";
import { riskOf, summarize } from "./tools.js";

export interface ClaudeCodeOptions extends BackendOptions {
  /** Binary to launch. Overridable so tests can point at a stub. */
  bin: string;
  /** Passed through to `claude --permission-mode`. */
  permissionMode: string;
  /** Resume an existing Claude Code session id instead of starting fresh. */
  resume?: string | null;
  extraArgs?: string[];
}

/**
 * Backend that shares a real `claude` CLI session with the room.
 *
 * One long-lived `claude -p --input-format stream-json --output-format
 * stream-json` process is the session; every approved prompt from the room is
 * written to its stdin, and its output is fanned out to every seat. That is
 * what makes this literally *your* AI session turned multiplayer rather than a
 * parallel one.
 *
 * Tool permissions here belong to Claude Code itself (`--permission-mode`,
 * `--allowedTools`); the room still votes on everything that goes *in*. The
 * built-in `anthropic` backend is the one that also puts tool calls to a vote.
 */
export class ClaudeCodeBackend implements AgentBackend {
  readonly name = "claude-code";
  readonly model: string;
  private opts: ClaudeCodeOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private sessionId: string | null = null;
  private active: {
    events: AgentEvents;
    resolve: (r: TurnResult) => void;
    usage: Record<string, number>;
  } | null = null;
  private exitError: string | null = null;

  constructor(opts: ClaudeCodeOptions) {
    this.opts = opts;
    this.model = opts.model || "claude-code";
  }

  private start(): void {
    if (this.child) return;
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      this.opts.permissionMode,
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    if (this.opts.resume) args.push("--resume", this.opts.resume);
    if (this.opts.systemPrompt) args.push("--append-system-prompt", this.opts.systemPrompt);
    if (this.opts.extraArgs?.length) args.push(...this.opts.extraArgs);

    const child = spawn(this.opts.bin, args, {
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    }) as ChildProcessWithoutNullStreams;
    this.child = child;

    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.onLine(line));

    let stderr = "";
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("exit", (code, signal) => {
      this.child = null;
      const why = signal ? `killed by ${signal}` : `exited with code ${code}`;
      this.exitError = `claude ${why}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`;
      // A crash mid-turn must not hang the room forever.
      this.finish({ stopReason: "error", usage: {}, error: this.exitError });
    });
    child.on("error", (err) => {
      this.exitError = `could not launch "${this.opts.bin}": ${err.message}`;
      this.finish({ stopReason: "error", usage: {}, error: this.exitError });
    });
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return; // non-JSON chatter on stdout is not ours to interpret
    }
    const active = this.active;

    switch (ev.type) {
      case "system":
        if (ev.subtype === "init" && typeof ev.session_id === "string") {
          this.sessionId = ev.session_id;
          active?.events.onNotice(`claude session ${ev.session_id.slice(0, 8)}`);
        }
        return;

      case "stream_event": {
        const inner = ev.event;
        if (!active || !inner) return;
        if (inner.type === "content_block_delta") {
          if (inner.delta?.type === "text_delta") active.events.onText(inner.delta.text ?? "");
          else if (inner.delta?.type === "thinking_delta" && this.opts.showThinking) {
            active.events.onThinking(inner.delta.thinking ?? "");
          }
        }
        return;
      }

      case "assistant": {
        if (!active) return;
        // Surface tool calls so the room can watch what the session is doing.
        for (const block of ev.message?.content ?? []) {
          if (block?.type === "tool_use") {
            active.events.onToolResult(
              block.id ?? "",
              true,
              `${summarize(block.name, block.input)} [${riskOf(block.name)}]`,
            );
          }
        }
        const u = ev.message?.usage;
        if (u && active) {
          active.usage.input_tokens = (active.usage.input_tokens ?? 0) + (u.input_tokens ?? 0);
          active.usage.output_tokens = (active.usage.output_tokens ?? 0) + (u.output_tokens ?? 0);
        }
        return;
      }

      case "result": {
        if (!active) return;
        const err = ev.is_error ? String(ev.result ?? ev.subtype ?? "error") : undefined;
        this.finish({
          stopReason: ev.subtype === "success" ? "end_turn" : String(ev.subtype ?? "end_turn"),
          usage: active.usage,
          ...(err ? { error: err } : {}),
        });
        return;
      }
    }
  }

  private finish(r: TurnResult): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    active.resolve(r);
  }

  async send(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnResult> {
    this.start();
    if (!this.child) {
      return { stopReason: "error", usage: {}, error: this.exitError ?? "claude is not running" };
    }
    if (this.active) {
      return { stopReason: "error", usage: {}, error: "a turn is already in flight" };
    }

    return await new Promise<TurnResult>((resolve) => {
      const usage: Record<string, number> = {};
      this.active = { events, resolve, usage };

      const onAbort = () => {
        // stream-json mode has no soft interrupt; restarting the process is the
        // reliable stop, and `--resume` picks the conversation back up.
        this.child?.kill("SIGTERM");
        this.finish({ stopReason: "interrupted", usage });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const frame = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
        ...(this.sessionId ? { session_id: this.sessionId } : {}),
      };
      this.child!.stdin.write(JSON.stringify(frame) + "\n", (err) => {
        if (err) this.finish({ stopReason: "error", usage, error: `write failed: ${err.message}` });
      });
    }).finally(() => {
      // Keep the process alive between turns — that is the shared session.
    });
  }

  async close(): Promise<void> {
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 2000);
      t.unref?.();
      child.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }

  /** Claude Code's own session id, once it reports one. */
  get session(): string | null {
    return this.sessionId;
  }
}
