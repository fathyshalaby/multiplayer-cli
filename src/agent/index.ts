import type { AgentBackend, BackendOptions } from "./types.js";
import { AnthropicBackend } from "./anthropic.js";
import { ClaudeCodeBackend } from "./claudeCode.js";
import { EchoBackend } from "./echo.js";
import { ProcessBackend } from "./process.js";
import { PROFILES } from "./profiles.js";

export type BackendName =
  | "anthropic"
  | "claude-code"
  | "codex"
  | "copilot"
  | "opencode"
  | "opencode-json"
  | "gemini"
  | "cursor"
  | "aider"
  | "amp"
  | "echo";

export const BACKENDS: BackendName[] = [
  "anthropic",
  "claude-code",
  "codex",
  "copilot",
  "opencode",
  "opencode-json",
  "gemini",
  "cursor",
  "aider",
  "amp",
  "echo",
];

/** One line each, for `mpx backends` and the error you get after a typo. */
export const BACKEND_HELP: Record<BackendName, string> = {
  anthropic: "Claude via the API, owned by the room. The only backend where the room also votes on tool calls.",
  "claude-code": "A real `claude` session, shared. One long-lived process; every seat sees the same stream.",
  codex: "OpenAI Codex (`codex exec --json`). Structured events; resumes the same thread each turn.",
  copilot: "GitHub Copilot CLI (`copilot -p`). Plain text — it has no machine-readable mode.",
  opencode: "OpenCode (`opencode run`). Use --attach to ride a server other clients are already on.",
  "opencode-json": "OpenCode with `--format json`, for structured events instead of plain text.",
  gemini: "Google Gemini CLI (`gemini -p`). Plain text; each turn starts fresh.",
  cursor: "Cursor CLI (`cursor-agent -p`). Plain text; pass --resume to continue a thread.",
  aider: "Aider (`aider --message --yes-always`). Applies edits and exits; each turn starts fresh.",
  amp: "Amp (`amp -x`). Execute mode; each turn starts fresh.",
  echo: "Offline stand-in. No key, no spend — a full dry run of the room.",
};

/** Backends whose profile learns and reuses the tool's own session id. */
export function carriesSession(backend: BackendName): boolean {
  if (backend === "anthropic" || backend === "echo") return true;
  if (backend === "claude-code") return true;
  return PROFILES[backend]?.carriesSession ?? false;
}

/** Backends where the room can vote on the model's tool calls, not just its prompts. */
export const GATES_TOOLS: BackendName[] = ["anthropic", "echo"];

export interface CreateOptions extends BackendOptions {
  backend: BackendName;
  /** Override the binary a CLI backend launches. */
  backendBin: string;
  /** Verbatim extra arguments appended to a CLI backend's command line. */
  backendArgs: string[];
  permissionMode: string;
  /** Session/thread id to continue, in whatever form that backend uses. */
  resume?: string | null;
  /** URL of an already-running server to attach to (OpenCode). */
  attach?: string | null;
}

export function createBackend(opts: CreateOptions): AgentBackend {
  switch (opts.backend) {
    case "echo":
      return new EchoBackend(opts);

    case "claude-code":
      return new ClaudeCodeBackend({
        ...opts,
        bin: opts.backendBin || "claude",
        permissionMode: opts.permissionMode,
        resume: opts.resume ?? null,
        extraArgs: opts.backendArgs,
      });

    case "codex":
    case "copilot":
    case "opencode":
    case "opencode-json":
    case "gemini":
    case "cursor":
    case "aider":
    case "amp": {
      const profile = PROFILES[opts.backend]!;
      const extraArgs = [...opts.backendArgs];
      // Attaching points OpenCode at a server other clients may already be on,
      // so the room joins an existing shared session instead of starting one.
      if (opts.attach && opts.backend.startsWith("opencode")) {
        extraArgs.unshift("--attach", opts.attach);
      }
      return new ProcessBackend({
        profile,
        cwd: opts.cwd,
        model: opts.model,
        bin: opts.backendBin,
        extraArgs,
        resume: opts.resume ?? null,
        showThinking: opts.showThinking,
      });
    }

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
export { ProcessBackend } from "./process.js";
export { PROFILES } from "./profiles.js";
