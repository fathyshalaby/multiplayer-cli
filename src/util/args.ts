export interface Parsed {
  command: string | null;
  positional: string[];
  flags: Map<string, string | boolean>;
}

/**
 * Minimal argv parser. Supports `--key value`, `--key=value`, `--flag`,
 * `--no-flag`, and `-abc` style short flags mapped by the caller.
 */
export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith("no-")) {
        flags.set(body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(body, next);
        i++;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const next = argv[i + 1];
      const key = arg.slice(1);
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
      continue;
    }
    if (command === null) command = arg;
    else positional.push(arg);
  }
  return { command, positional, flags };
}

export function str(p: Parsed, key: string, fallback: string): string {
  const v = p.flags.get(key);
  return typeof v === "string" ? v : fallback;
}

export function num(p: Parsed, key: string, fallback: number): number {
  const v = p.flags.get(key);
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function bool(p: Parsed, key: string, fallback: boolean): boolean {
  const v = p.flags.get(key);
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  return fallback;
}

export function list(p: Parsed, key: string): string[] {
  const v = p.flags.get(key);
  if (typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}
