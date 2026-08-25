import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { AgentBackend, AgentEvents, TurnResult } from "./types.js";

/**
 * Everything the room needs to know about one turn, normalized away from
 * whichever CLI produced it. Profiles push into this; the backend fans it out.
 */
export interface ProfileSink {
  text(s: string): void;
  thinking(s: string): void;
  /** The tool the underlying CLI is about to run, announced to the room. */
  tool(id: string, summary: string): void;
  toolDone(id: string, ok: boolean, preview: string): void;
  /** The CLI's own session/thread id, captured so the next turn can resume it. */
  session(id: string): void;
  usage(u: Record<string, number>): void;
  /** The CLI reported the turn is over; further output is ignored. */
  done(stopReason: string, error?: string): void;
  notice(s: string): void;
}

export interface TurnContext {
  prompt: string;
  /** Session id captured from an earlier turn, or the one the host passed in. */
  sessionId: string | null;
  cwd: string;
  model: string;
  /** True on the first turn of this room, when there is nothing to resume. */
  first: boolean;
  /** Verbatim extras from `--backend-arg`, appended last so they win. */
  extraArgs: string[];
}

/**
 * A declarative description of how to drive one coding CLI for one turn.
 *
 * These tools move fast, so a profile is deliberately small: build an argv,
 * say how output is framed, and map that tool's events onto the sink. Adding
 * a new CLI is a profile, not a class.
 */
export interface CliProfile {
  name: string;
  /** Default binary name; overridable with `--backend-bin`. */
  bin: string;
  /** `jsonl` parses each stdout line as an event; `text` streams stdout as-is. */
  parse: "jsonl" | "text";
  args(ctx: TurnContext): string[];
  /** Required for `jsonl`. Called once per parsed line. */
  onEvent?(ev: any, sink: ProfileSink): void;
  /** Shown when the binary is missing, so the error is actionable. */
  install: string;
  /** Whether the tool accepts a session id to continue, if one is supplied. */
  resumable: boolean;
  /**
   * Whether this profile learns the tool's session id on its own and reuses it.
   *
   * False means every turn starts the tool fresh: the room is still one
   * conversation to the people in it, but not to the model. Worth saying out
   * loud rather than letting a room discover it halfway through.
   */
  carriesSession: boolean;
  /** How the prompt reaches the process. */
  promptVia: "arg" | "stdin";
}

export interface ProcessBackendOptions {
  profile: CliProfile;
  cwd: string;
  model: string;
  /** Override the profile's default binary. */
  bin?: string;
  /** Appended to every invocation. */
  extraArgs?: string[];
  /** Session/thread id to continue instead of starting fresh. */
  resume?: string | null;
  showThinking: boolean;
}

/**
 * Drives a CLI that takes one turn per process and remembers the conversation
 * itself — Codex, Copilot, OpenCode and most others work this way.
 *
 * Continuity comes from the tool's own session id: the first turn starts fresh,
 * captures whatever id the tool reports, and every later turn resumes it. So
 * the room really is sharing one session, not replaying a transcript.
 */
export class ProcessBackend implements AgentBackend {
  readonly name: string;
  readonly model: string;
  private opts: ProcessBackendOptions;
  private profile: CliProfile;
  private sessionId: string | null;
  private child: ChildProcess | null = null;
  private turns = 0;

  constructor(opts: ProcessBackendOptions) {
    this.opts = opts;
    this.profile = opts.profile;
    this.name = opts.profile.name;
    this.model = opts.model;
    this.sessionId = opts.resume ?? null;
  }

  /** The tool's own session id, once known — printed so it can be resumed. */
  get session(): string | null {
    return this.sessionId;
  }

  async send(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnResult> {
    const ctx: TurnContext = {
      prompt,
      sessionId: this.sessionId,
      cwd: this.opts.cwd,
      model: this.opts.model,
      first: this.turns === 0 && !this.sessionId,
      extraArgs: this.opts.extraArgs ?? [],
    };
    this.turns += 1;

    const bin = this.opts.bin || this.profile.bin;
    const args = this.profile.args(ctx);

    return await new Promise<TurnResult>((resolve) => {
      const usage: Record<string, number> = {};
      let stopReason: string | null = null;
      let error: string | undefined;
      let settled = false;
      let stderr = "";
      let sawOutput = false;

      const finish = (r: TurnResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(r);
      };

      const sink: ProfileSink = {
        text: (s) => {
          if (!s) return;
          sawOutput = true;
          events.onText(s);
        },
        thinking: (s) => {
          if (s && this.opts.showThinking) events.onThinking(s);
        },
        tool: (id, summary) => events.onToolResult(id, true, summary),
        toolDone: (id, ok, preview) => events.onToolResult(id, ok, preview),
        session: (sid) => {
          if (!sid || sid === this.sessionId) return;
          this.sessionId = sid;
          events.onNotice(`${this.profile.name} session ${short(sid)}`);
        },
        usage: (u) => Object.assign(usage, u),
        done: (reason, err) => {
          stopReason = reason;
          error = err;
        },
        notice: (s) => events.onNotice(s),
      };

      let child: ChildProcess;
      try {
        child = spawn(bin, args, {
          cwd: this.opts.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: process.env,
        });
      } catch (err) {
        finish({ stopReason: "error", usage, error: `could not launch "${bin}": ${(err as Error).message}` });
        return;
      }
      this.child = child;

      let lines: Interface | null = null;
      if (this.profile.parse === "jsonl") {
        lines = createInterface({ input: child.stdout! });
        lines.on("line", (line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          let ev: unknown;
          try {
            ev = JSON.parse(trimmed);
          } catch {
            // Not every line of a JSON stream is JSON — banners and warnings
            // land here. Show them rather than silently dropping output.
            sink.text(trimmed + "\n");
            return;
          }
          try {
            this.profile.onEvent?.(ev, sink);
          } catch (err) {
            sink.notice(`could not read a ${this.profile.name} event: ${(err as Error).message}`);
          }
        });
      } else {
        child.stdout!.on("data", (chunk: Buffer) => sink.text(chunk.toString("utf8")));
      }

      child.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 8000) stderr = stderr.slice(-8000);
      });

      const onAbort = () => {
        child.kill("SIGTERM");
        const t = setTimeout(() => child.kill("SIGKILL"), 2000);
        t.unref?.();
        finish({ stopReason: "interrupted", usage });
      };
      signal.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        lines?.close();
      };

      child.on("error", (err) => {
        const msg =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `"${bin}" is not installed or not on PATH — ${this.profile.install}`
            : `could not launch "${bin}": ${err.message}`;
        finish({ stopReason: "error", usage, error: msg });
      });

      child.on("close", (code, sig) => {
        this.child = null;
        if (settled) return;
        if (stopReason) {
          finish({ stopReason, usage, ...(error ? { error } : {}) });
          return;
        }
        if (code === 0) {
          finish({ stopReason: "end_turn", usage });
          return;
        }
        // A non-zero exit with nothing on stdout is a real failure; with output
        // already streamed it is usually a warning the room can judge for itself.
        const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
        const why = sig ? `killed by ${sig}` : `exit ${code}`;
        finish({
          stopReason: sawOutput ? "end_turn" : "error",
          usage,
          error: sawOutput ? undefined : `${bin} ${why}${detail ? `: ${detail}` : ""}`,
        });
      });

      if (this.profile.promptVia === "stdin") {
        child.stdin!.end(prompt);
      } else {
        child.stdin!.end();
      }
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.kill("SIGTERM");
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        r();
      }, 1500);
      t.unref?.();
      child.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  }
}

function short(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}
