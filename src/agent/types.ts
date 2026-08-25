import type { ToolRequest } from "../protocol.js";

export interface AgentEvents {
  /** Streaming assistant output. */
  onText(text: string): void;
  /** Streaming reasoning summary, rendered dimly and separately. */
  onThinking(text: string): void;
  /**
   * The model wants to run a tool. Resolve with a decision; the room may take
   * as long as it likes to vote, and the turn simply waits.
   */
  onToolRequest(req: ToolRequest): Promise<{ allow: boolean; reason: string }>;
  /** A tool finished; `preview` is a short rendering for the transcript. */
  onToolResult(toolUseId: string, ok: boolean, preview: string): void;
  onNotice(text: string): void;
}

export interface TurnResult {
  stopReason: string;
  usage?: Record<string, number>;
  error?: string;
  /**
   * The turn failed because this account is out of capacity — a usage cap, a
   * rate limit, exhausted credit. The room can hand the session to someone
   * else's subscription instead of giving up.
   */
  limited?: boolean;
  /** When that capacity is expected back, if the tool said so. */
  until?: number | null;
}

export interface AgentBackend {
  readonly name: string;
  readonly model: string;
  /** Send one user turn and stream the response. Rejects only on fatal errors. */
  send(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnResult>;
  /** Free any resources (child processes, sockets). */
  close(): Promise<void>;
}

export interface BackendOptions {
  cwd: string;
  model: string;
  systemPrompt: string;
  /** Cap on model output tokens per turn. */
  maxTokens: number;
  /** Show summarized reasoning in the shared transcript. */
  showThinking: boolean;
}
