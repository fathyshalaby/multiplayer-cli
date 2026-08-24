import type { AgentBackend, AgentEvents, BackendOptions, TurnResult } from "./types.js";

/**
 * A deterministic, offline stand-in for a model.
 *
 * Exists so the collaboration machinery — joining, proposing, voting, tool
 * approval, interrupts — can be demonstrated and tested without an API key or
 * a cent of spend. `mpx host --backend echo` is a complete dry run of the room.
 */
export class EchoBackend implements AgentBackend {
  readonly name = "echo";
  readonly model = "echo";
  private turns = 0;
  private opts: BackendOptions;

  constructor(opts: BackendOptions) {
    this.opts = opts;
  }

  async send(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnResult> {
    this.turns += 1;
    const words = [
      `Turn ${this.turns} received by the shared session.`,
      `The room sent ${prompt.split(/\s+/).length} words.`,
      `Working directory is ${this.opts.cwd}.`,
      "",
      "> " + prompt.split("\n").join("\n> "),
    ]
      .join("\n")
      .split(/(\s+)/);

    for (const w of words) {
      if (signal.aborted) return { stopReason: "interrupted", usage: { output_tokens: this.turns } };
      events.onText(w);
      await sleep(12);
    }

    // Every third turn, ask for a tool so the tool-approval vote is exercised.
    if (this.turns % 3 === 0) {
      const decision = await events.onToolRequest({
        toolUseId: `echo_${this.turns}`,
        name: "bash",
        input: { command: "echo hello from the shared session" },
        risk: "exec",
        summary: "bash: echo hello from the shared session",
      });
      if (decision.allow) {
        events.onToolResult(`echo_${this.turns}`, true, "hello from the shared session");
        events.onText("\n\nThe command ran.");
      } else {
        events.onToolResult(`echo_${this.turns}`, false, `denied — ${decision.reason}`);
        events.onText(`\n\nThe room declined that command (${decision.reason}).`);
      }
    }

    return { stopReason: "end_turn", usage: { output_tokens: words.length } };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}
