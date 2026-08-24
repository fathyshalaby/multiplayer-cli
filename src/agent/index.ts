import type { AgentBackend, BackendOptions } from "./types.js";
import { AnthropicBackend } from "./anthropic.js";
import { ClaudeCodeBackend } from "./claudeCode.js";
import { EchoBackend } from "./echo.js";

export type BackendName = "anthropic" | "claude-code" | "echo";

export const BACKENDS: BackendName[] = ["anthropic", "claude-code", "echo"];

export interface CreateOptions extends BackendOptions {
  backend: BackendName;
  claudeBin: string;
  permissionMode: string;
  resume?: string | null;
}

export function createBackend(opts: CreateOptions): AgentBackend {
  switch (opts.backend) {
    case "echo":
      return new EchoBackend(opts);
    case "claude-code":
      return new ClaudeCodeBackend({
        ...opts,
        bin: opts.claudeBin,
        permissionMode: opts.permissionMode,
        resume: opts.resume ?? null,
      });
    case "anthropic":
    default:
      return new AnthropicBackend(opts);
  }
}

/** System prompt that tells the model it is talking to a room, not a person. */
export function multiplayerSystemPrompt(extra: string, participants: string[], cwd: string): string {
  const roster = participants.length ? participants.join(", ") : "one person so far";
  return [
    "You are the shared assistant in a multiplayer terminal session. Several people are in the room together, and every message you receive was agreed on by the group before it was sent to you.",
    `Currently in the room: ${roster}. Working directory: ${cwd}.`,
    "",
    "Because the session is shared:",
    "- Messages may be prefixed with the name of who wrote them and who approved them. Address people by name when a question is clearly theirs.",
    "- A single turn may bundle several people's messages. Answer all of them, and say so when they conflict rather than silently picking one.",
    "- If the group disagrees about direction, lay out the tradeoff plainly and ask for a decision instead of choosing for them.",
    "- Tool calls may be put to a vote and declined. A declined tool is a decision, not an error: explain what you would have done and offer an alternative.",
    "- Keep answers tight. Everyone in the room reads every word you write.",
    extra.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

export type { AgentBackend, BackendOptions };
