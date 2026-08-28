import type { ServerMessage } from "../protocol.js";
import type { AgentBackend } from "../agent/types.js";
import { createBackend, multiplayerSystemPrompt, GATES_TOOLS, type BackendName } from "../agent/index.js";
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
    // Say it on the machine that carries the risk, too: these are the backends
    // whose tool calls the room would have voted on had the turn stayed home.
    if (GATES_TOOLS.includes(this.opts.backend)) {
      this.opts.onNotice(
        `heads up: turns that land here run ${this.opts.backend}'s tool calls on this machine without a room vote — ` +
          `the room only votes on tool calls for turns it runs itself`,
      );
    }
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
          /**
           * Auto-approved here, and that is a real gap on two backends.
           *
           * For a CLI backend this is simply true: `codex` and `claude` run
           * their own agent loops and their own permission systems, and we
           * never see a tool call to put to a vote in the first place. The
           * room voted on the prompt; the tool's own rules take it from there.
           *
           * On `anthropic` and `echo` it is not true. Those are the two where
           * mpx owns the loop, and where a turn on the *host* would stop
           * between the model asking for a tool and the tool running, and put
           * it to the room. A turn on a runner does not: the request never
           * leaves this machine, so nobody votes on it, and a room set to
           * `strict` — where nothing at all is auto-allowed — silently gets
           * something weaker than it asked for.
           *
           * Closing it properly means carrying the approval back over the
           * socket and blocking here until the room answers, which is a
           * protocol change and needs an answer for a runner that drops
           * mid-vote. Until then the room and the runner are both told, at
           * `offer()` below and where the room is notified, rather than the
           * guarantee quietly not holding.
           */
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
