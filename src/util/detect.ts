import { accessSync, constants } from "node:fs";
import { join, delimiter } from "node:path";

/** Is this binary on PATH and executable? */
export function onPath(bin: string): boolean {
  if (bin.includes("/")) return canExec(bin);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && canExec(join(dir, bin))) return true;
  }
  return false;
}

function canExec(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface Detected {
  backend: string;
  why: string;
}

/**
 * Pick a backend for someone who has not said which one they want.
 *
 * Order is "whatever they already have installed", because the point of
 * `mpx share` is that it works without being configured. Anything found here
 * is only a default — `--backend` always wins.
 */
export function detectBackend(): Detected {
  const candidates: { bin: string; backend: string }[] = [
    { bin: "claude", backend: "claude-code" },
    { bin: "codex", backend: "codex" },
    { bin: "opencode", backend: "opencode" },
    { bin: "copilot", backend: "copilot" },
  ];
  for (const c of candidates) {
    if (onPath(c.bin)) return { backend: c.backend, why: `found \`${c.bin}\` on your PATH` };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { backend: "anthropic", why: "using ANTHROPIC_API_KEY" };
  }
  return {
    backend: "echo",
    why: "no coding CLI found — running the offline demo backend, so you can still see how a room works",
  };
}

/** Everything installed, for `mpx backends` to mark up. */
export function installedBackends(): Set<string> {
  const found = new Set<string>();
  if (onPath("claude")) found.add("claude-code");
  if (onPath("codex")) found.add("codex");
  if (onPath("opencode")) {
    found.add("opencode");
    found.add("opencode-json");
  }
  if (onPath("copilot")) found.add("copilot");
  if (process.env.ANTHROPIC_API_KEY) found.add("anthropic");
  found.add("echo");
  return found;
}
