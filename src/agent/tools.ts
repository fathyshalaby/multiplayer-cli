import { spawn } from "node:child_process";
import { readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolRisk } from "../protocol.js";

/**
 * A small, honest tool surface for the built-in Anthropic backend.
 *
 * Every tool is classified by risk so the room's policy can auto-allow reads
 * while still putting a vote in front of anything that writes or executes.
 */
export const TOOL_RISK: Record<string, ToolRisk> = {
  read_file: "read",
  list_dir: "read",
  search: "read",
  write_file: "write",
  bash: "exec",
  // Asking the room is not an action on anything; it is handled before the
  // risk gate ever sees it, and listed here only so nothing treats it as
  // unclassified.
  ask_room: "read",
};

/** Handled by the backend itself rather than run, so the room can vote on it. */
export const ASK_ROOM = "ask_room";

export const TOOLS: Anthropic.Tool[] = [
  {
    name: ASK_ROOM,
    description: [
      "Put a fork in the road to the room and wait for them to pick.",
      "",
      "Use this when you reach two or more defensible directions and choosing wrong means redoing the work — especially when the answer is a decision rather than a fact: product intent, backwards compatibility, how much scope to take on. Everyone in the room votes and you are told what they chose.",
      "Do not use it for anything you could settle by reading the repository, and do not use it to ask permission for a tool call — the room already votes on those.",
    ].join("\n"),
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The decision, in one line." },
        options: {
          type: "array",
          description: "Two to six real courses of action, each one line.",
          items: { type: "string" },
          minItems: 2,
          maxItems: 6,
        },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the shared working directory. Returns the file with line numbers.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the working directory." },
        start: { type: "integer", description: "First line to return (1-indexed)." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a directory in the shared working directory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory path, default '.'." } },
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Search file contents for a regular expression, like grep -rn.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "Directory to search, default '.'." },
        glob: { type: "string", description: "Only search files whose name matches this suffix, e.g. '.ts'." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a text file in the shared working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description: "Run a shell command in the shared working directory and return its output.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_ms: { type: "integer", description: "Kill the command after this long. Default 60000." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

export function riskOf(name: string): ToolRisk {
  // Anything unrecognised is treated as the most dangerous class, so adding a
  // tool without classifying it fails closed rather than open.
  return TOOL_RISK[name] ?? "exec";
}

/** One-line rendering shown to the room when it votes on a tool call. */
export function summarize(name: string, input: any): string {
  switch (name) {
    case "read_file":
      return `read ${input?.path}`;
    case "list_dir":
      return `list ${input?.path ?? "."}`;
    case "search":
      return `search /${input?.pattern}/ in ${input?.path ?? "."}`;
    case "write_file": {
      const bytes = typeof input?.content === "string" ? input.content.length : 0;
      return `write ${input?.path} (${bytes} bytes)`;
    }
    case "bash":
      return `bash: ${String(input?.command ?? "").split("\n")[0]}`;
    default:
      return `${name} ${JSON.stringify(input).slice(0, 120)}`;
  }
}

export interface ToolOutcome {
  ok: boolean;
  content: string;
}

/**
 * Resolve every symlink we can, keeping the part that does not exist yet.
 *
 * `write_file` legitimately names a file that is not there, so realpath on the
 * whole path would throw and there would be nothing to check. Walk up to the
 * deepest ancestor that does exist, resolve *that*, and put the remaining
 * segments back on the end.
 */
async function resolveLinks(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p; // reached the filesystem root; nothing resolved
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Refuse to escape the room's working directory, symlinks included.
 *
 * The lexical check stops `../` and absolute paths, and it used to be the whole
 * function — which meant it did not do what its own comment claimed. `resolve`
 * does not follow symlinks, so a link inside the room pointing anywhere else
 * was a lexically innocent path: `sub/link/id_rsa` has no `..` in it, and both
 * reads and writes went straight through to wherever the link led.
 *
 * That is worth more than it looks. `read` is auto-allowed in every preset
 * except `strict`, so an escape here is not gated by a vote at all — in a tool
 * whose entire claim is that the room agrees first. Repositories that contain a
 * link out of themselves are ordinary: monorepo package links, a checkout with
 * a link to `$HOME`, a fixture directory pointing at shared data.
 *
 * So resolve both sides and check again. Both, because the room's own cwd may
 * itself be reached through a link (`/tmp` is one on macOS), and comparing a
 * resolved target against an unresolved root rejects every legitimate path.
 */
async function safePath(cwd: string, p: string): Promise<string | null> {
  const target = isAbsolute(p) ? p : resolve(cwd, p);

  // Cheap first, and it catches `../` before touching the disk at all.
  const lexical = relative(cwd, target);
  if (lexical.startsWith("..") || isAbsolute(lexical)) return null;

  const rootReal = await realpath(cwd).catch(() => cwd);
  const targetReal = await resolveLinks(target);
  const rel = relative(rootReal, targetReal);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

export async function runTool(cwd: string, name: string, input: any): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "read_file":
        return await toolReadFile(cwd, input);
      case "list_dir":
        return await toolListDir(cwd, input);
      case "search":
        return await toolSearch(cwd, input);
      case "write_file":
        return await toolWriteFile(cwd, input);
      case "bash":
        return await toolBash(cwd, input);
      default:
        return { ok: false, content: `unknown tool ${name}` };
    }
  } catch (err) {
    return { ok: false, content: `${name} failed: ${(err as Error).message}` };
  }
}

async function toolReadFile(cwd: string, input: any): Promise<ToolOutcome> {
  const target = await safePath(cwd, String(input.path ?? ""));
  if (!target) return { ok: false, content: "path escapes the shared working directory" };
  const text = await readFile(target, "utf8");
  const lines = text.split("\n");
  const start = Math.max(1, Number(input.start ?? 1));
  const limit = Math.max(1, Number(input.limit ?? 2000));
  const slice = lines.slice(start - 1, start - 1 + limit);
  const body = slice.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join("\n");
  const more = lines.length > start - 1 + slice.length ? `\n… ${lines.length - (start - 1 + slice.length)} more lines` : "";
  return { ok: true, content: body + more };
}

async function toolListDir(cwd: string, input: any): Promise<ToolOutcome> {
  const target = await safePath(cwd, String(input.path ?? "."));
  if (!target) return { ok: false, content: "path escapes the shared working directory" };
  const entries = await readdir(target, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries.slice(0, 500)) {
    if (e.isDirectory()) out.push(`${e.name}/`);
    else {
      const s = await stat(resolve(target, e.name)).catch(() => null);
      out.push(`${e.name}${s ? ` (${s.size}b)` : ""}`);
    }
  }
  return { ok: true, content: out.join("\n") || "(empty)" };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__"]);

async function toolSearch(cwd: string, input: any): Promise<ToolOutcome> {
  const root = await safePath(cwd, String(input.path ?? "."));
  if (!root) return { ok: false, content: "path escapes the shared working directory" };
  let re: RegExp;
  try {
    re = new RegExp(String(input.pattern), "g");
  } catch (err) {
    return { ok: false, content: `bad pattern: ${(err as Error).message}` };
  }
  const suffix = input.glob ? String(input.glob) : null;
  const hits: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || hits.length >= 200) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (hits.length >= 200) return;
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = resolve(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(full, depth + 1);
        continue;
      }
      // A symlink is not a directory, so it fell through to be read below —
      // the same escape as safePath's, reached by walking instead of naming.
      // Skipping them outright is what ripgrep does by default.
      if (e.isSymbolicLink()) continue;
      if (suffix && !e.name.endsWith(suffix)) continue;
      const s = await stat(full).catch(() => null);
      if (!s || s.size > 2_000_000) continue;
      const text = await readFile(full, "utf8").catch(() => null);
      if (text === null) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < 200; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i]!)) hits.push(`${relative(cwd, full)}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
      }
    }
  };
  await walk(root, 0);
  return { ok: true, content: hits.length ? hits.join("\n") : "no matches" };
}

async function toolWriteFile(cwd: string, input: any): Promise<ToolOutcome> {
  const target = await safePath(cwd, String(input.path ?? ""));
  if (!target) return { ok: false, content: "path escapes the shared working directory" };
  await writeFile(target, String(input.content ?? ""), "utf8");
  return { ok: true, content: `wrote ${relative(cwd, target)}` };
}

async function toolBash(cwd: string, input: any): Promise<ToolOutcome> {
  const command = String(input.command ?? "");
  const timeout = Math.min(600_000, Math.max(1000, Number(input.timeout_ms ?? 60_000)));
  return await new Promise<ToolOutcome>((resolvePromise) => {
    const child = spawn("bash", ["-lc", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let done = false;
    const cap = (chunk: Buffer) => {
      if (out.length < 100_000) out += chunk.toString("utf8");
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    const timer = setTimeout(() => {
      if (!done) child.kill("SIGKILL");
    }, timeout);
    timer.unref?.();
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, content: `spawn failed: ${err.message}` });
    });
    child.on("close", (code, sig) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const trailer = sig ? `\n[killed by ${sig}]` : code === 0 ? "" : `\n[exit ${code}]`;
      resolvePromise({ ok: code === 0, content: (out.trim() || "(no output)") + trailer });
    });
  });
}
