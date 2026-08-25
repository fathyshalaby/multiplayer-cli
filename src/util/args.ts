export interface Parsed {
  command: string | null;
  positional: string[];
  flags: Map<string, string | boolean>;
  /** Every value seen for each flag, in order, for repeatable options. */
  repeated: Map<string, string[]>;
}

/**
 * Minimal argv parser. Supports `--key value`, `--key=value`, `--flag`,
 * `--no-flag`, and `-abc` style short flags mapped by the caller.
 */
export function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string | boolean>();
  const repeated = new Map<string, string[]>();
  const positional: string[] = [];
  let command: string | null = null;

  const set = (key: string, value: string | boolean) => {
    flags.set(key, value);
    if (typeof value === "string") {
      const prior = repeated.get(key) ?? [];
      prior.push(value);
      repeated.set(key, prior);
    }
  };

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
        set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (body.startsWith("no-")) {
        set(body.slice(3), false);
        continue;
      }
      const next = argv[i + 1];
      // A repeatable pass-through value may itself look like a flag, so take
      // the next token verbatim for those rather than treating it as boolean.
      const passThrough = body === "backend-arg" || body === "set";
      if (next !== undefined && (passThrough || !next.startsWith("-"))) {
        set(body, next);
        i++;
      } else {
        set(body, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const next = argv[i + 1];
      const key = arg.slice(1);
      if (next !== undefined && !next.startsWith("-")) {
        set(key, next);
        i++;
      } else {
        set(key, true);
      }
      continue;
    }
    if (command === null) command = arg;
    else positional.push(arg);
  }
  return { command, positional, flags, repeated };
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

/** Every value given for a repeatable flag, in the order they were typed. */
export function multi(p: Parsed, key: string): string[] {
  return p.repeated.get(key) ?? [];
}
