import type { ServerMessage } from "../protocol.js";
import type { AgentBackend } from "../agent/types.js";
import { createBackend, multiplayerSystemPrompt, type BackendName } from "../agent/index.js";
import { classify } from "../agent/limits.js";
import type { Connection } from "./connection.js";

export interface RunnerOptions {
  connection: Connection;
  backend: BackendName;
  cwd: string;
  model: string;
  maxTokens: number;
  showThinking: boolean;
  backendBin: string;
  backendArgs: string[];
  permissionMode: string;
  resume: string | null;
  attach: string | null;
  onNotice(text: string): void;
}

/**
 * Offers this machine — and this person's own subscription — to the room.
 *
 * The room decides *what* is sent; a runner decides *whose* account sends it.
 * Turns arrive over the same socket the seat already has, execute against the
 * locally logged-in CLI, and stream back. Nobody hands anybody credentials:
 * every account only ever runs on the machine it is logged in on.
 */
export class LocalRunner {
  private opts: RunnerOptions;
  private backend: AgentBackend | null = null;
  private current: { turnId: string; abort: AbortController } | null = null;
  private registered = false;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  /** Tell the room this seat can take turns. */
  offer(): void {
    if (this.registered) return;
    this.registered = true;
    this.opts.connection.send({ t: "runner", backend: this.opts.backend, cwd: this.opts.cwd });
  }

  withdraw(): void {
    if (!this.registered) return;
    this.registered = false;
    this.opts.connection.send({ t: "runnerGone" });
  }

  get offering(): boolean {
    return this.registered;
  }

  /** Route the two messages a runner cares about; everything else is the TUI's. */
  handle(msg: ServerMessage): boolean {
    if (msg.t === "runTurn") {
      void this.run(msg.turnId, msg.prompt);
      return true;
    }
    if (msg.t === "runCancel") {
      if (this.current?.turnId === msg.turnId) this.current.abort.abort();
      return true;
    }
    return false;
  }

  private ensureBackend(participants: string[]): AgentBackend {
    if (this.backend) return this.backend;
    this.backend = createBackend({
      backend: this.opts.backend,
      cwd: this.opts.cwd,
      model: this.opts.model,
      maxTokens: this.opts.maxTokens,
      showThinking: this.opts.showThinking,
      systemPrompt: multiplayerSystemPrompt("", participants, this.opts.cwd),
      backendBin: this.opts.backendBin,
      backendArgs: this.opts.backendArgs,
      permissionMode: this.opts.permissionMode,
      resume: this.opts.resume,
      attach: this.opts.attach,
    });
    return this.backend;
  }

  private async run(turnId: string, prompt: string): Promise<void> {
    const conn = this.opts.connection;
    if (this.current) {
      conn.send({ t: "runEnd", turnId, stopReason: "error", error: "this runner is already busy" });
      return;
    }
    const abort = new AbortController();
    this.current = { turnId, abort };
    this.opts.onNotice(`running this turn on your ${this.opts.backend} session`);

    let result;
    try {
      const backend = this.ensureBackend([]);
      result = await backend.send(
        prompt,
        {
          onText: (text) => conn.send({ t: "runOut", turnId, kind: "text", text }),
          onThinking: (text) => conn.send({ t: "runOut", turnId, kind: "thinking", text }),
          // Tool approval belongs to whichever tool is running the turn; the
          // room already voted on the prompt that led here.
          onToolRequest: async () => ({ allow: true, reason: "runner-local policy" }),
          onToolResult: (toolUseId, ok, preview) => conn.send({ t: "runTool", turnId, toolUseId, ok, preview }),
          onNotice: (text) => conn.send({ t: "runNotice", turnId, text }),
        },
        abort.signal,
      );
    } catch (err) {
      result = { stopReason: "error", error: (err as Error)?.message ?? String(err) };
    } finally {
      this.current = null;
    }

    const marked = result.limited ? result : classify(result);
    conn.send({
      t: "runEnd",
      turnId,
      stopReason: marked.stopReason,
      ...(marked.usage ? { usage: marked.usage } : {}),
      ...(marked.error ? { error: marked.error } : {}),
      ...(marked.limited ? { limited: true } : {}),
      ...(marked.until !== undefined ? { until: marked.until } : {}),
    });
    if (marked.limited) {
      this.opts.onNotice("your account is out of capacity — the room will carry on elsewhere");
    }
  }

  async close(): Promise<void> {
    this.current?.abort.abort();
    this.current = null;
    await this.backend?.close();
    this.backend = null;
  }
}
