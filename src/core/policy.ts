import type { GatePolicy, RoomPolicy, ToolRisk } from "../protocol.js";

/**
 * Named presets, because nobody wants to hand-assemble a voting policy
 * before they can talk to a model.
 */
export const PRESETS: Record<string, RoomPolicy> = {
  /** No gate. Useful when you just want a shared screen. */
  solo: {
    prompt: gate({ mode: "open" }),
    tool: gate({ mode: "open" }),
    lane: gate({ mode: "owner", autoApproveMs: null, proposerAutoYes: false }),
    choice: gate({ mode: "owner", autoApproveMs: null, proposerAutoYes: false }),
    autoAllowToolRisks: ["read", "write", "exec"],
    interrupt: "anyone",
    mergeQueued: true,
    attribute: true,
  },
  /** Two or three people: anyone can veto, otherwise silence ships it. */
  pair: {
    prompt: gate({ mode: "consensus", autoApproveMs: 20_000, veto: true }),
    tool: gate({ mode: "consensus", autoApproveMs: 30_000, veto: true }),
    lane: gate({ mode: "consensus", autoApproveMs: null, proposerAutoYes: false }),
    choice: gate({ mode: "consensus", autoApproveMs: null, proposerAutoYes: false }),
    autoAllowToolRisks: ["read"],
    interrupt: "anyone",
    mergeQueued: true,
    attribute: true,
  },
  /** Default. Half the room approves, and a veto still stops it. */
  team: {
    prompt: gate({ mode: "majority", autoApproveMs: 45_000, veto: true }),
    tool: gate({ mode: "majority", autoApproveMs: null, veto: true }),
    lane: gate({ mode: "majority", autoApproveMs: null, proposerAutoYes: false }),
    choice: gate({ mode: "majority", autoApproveMs: null, proposerAutoYes: false }),
    autoAllowToolRisks: ["read"],
    interrupt: "anyone",
    mergeQueued: true,
    attribute: true,
  },
  /** Everyone must actively say yes. No timers, no assumptions. */
  strict: {
    prompt: gate({ mode: "consensus", autoApproveMs: null, veto: true, proposerAutoYes: false }),
    tool: gate({ mode: "consensus", autoApproveMs: null, veto: true, proposerAutoYes: false }),
    lane: gate({ mode: "consensus", autoApproveMs: null, proposerAutoYes: false }),
    choice: gate({ mode: "consensus", autoApproveMs: null, proposerAutoYes: false }),
    autoAllowToolRisks: [],
    interrupt: "owner",
    mergeQueued: false,
    attribute: true,
  },
  /** Demo / workshop mode: the host drives, everyone else suggests. */
  host: {
    prompt: gate({ mode: "owner", autoApproveMs: null }),
    tool: gate({ mode: "owner", autoApproveMs: null }),
    lane: gate({ mode: "owner", autoApproveMs: null, proposerAutoYes: false }),
    choice: gate({ mode: "owner", autoApproveMs: null, proposerAutoYes: false }),
    autoAllowToolRisks: ["read"],
    interrupt: "owner",
    mergeQueued: false,
    attribute: true,
  },
  /** Everyone gets the mic in turn. Good for structured sessions. */
  "round-robin": {
    prompt: gate({ mode: "round-robin" }),
    tool: gate({ mode: "majority", autoApproveMs: 45_000, veto: true }),
    lane: gate({ mode: "majority", autoApproveMs: null, proposerAutoYes: false }),
    choice: gate({ mode: "majority", autoApproveMs: null, proposerAutoYes: false }),
    autoAllowToolRisks: ["read"],
    interrupt: "anyone",
    mergeQueued: false,
    attribute: true,
  },
};

export const DEFAULT_PRESET = "team";

function gate(p: Partial<GatePolicy>): GatePolicy {
  return {
    mode: "majority",
    quorum: 2,
    veto: false,
    autoApproveMs: null,
    minYesOnTimeout: 0,
    proposerAutoYes: true,
    soloBypass: true,
    ...p,
  };
}

export function presetNames(): string[] {
  return Object.keys(PRESETS);
}

export function clonePolicy(p: RoomPolicy): RoomPolicy {
  return {
    prompt: { ...p.prompt },
    tool: { ...p.tool },
    lane: { ...p.lane },
    choice: { ...p.choice },
    autoAllowToolRisks: [...p.autoAllowToolRisks],
    interrupt: p.interrupt,
    mergeQueued: p.mergeQueued,
    attribute: p.attribute,
  };
}

export function resolvePreset(name: string): RoomPolicy | null {
  const p = PRESETS[name];
  return p ? clonePolicy(p) : null;
}

const RISKS: ToolRisk[] = ["read", "write", "exec"];

/**
 * Apply `key=value` overrides on top of a policy, as typed at the CLI or via
 * `/policy`. Unknown keys are reported rather than silently dropped, because a
 * typo in a safety setting should never look like it worked.
 */
export function applyOverrides(
  policy: RoomPolicy,
  pairs: string[],
): { policy: RoomPolicy; errors: string[] } {
  const next = clonePolicy(policy);
  const errors: string[] = [];

  for (const raw of pairs) {
    const eq = raw.indexOf("=");
    if (eq < 0) {
      errors.push(`expected key=value, got "${raw}"`);
      continue;
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    const err = applyOne(next, key, value);
    if (err) errors.push(err);
  }
  return { policy: next, errors };
}

function applyOne(p: RoomPolicy, key: string, value: string): string | null {
  // `tool.mode=owner` targets the tool gate; a bare key targets the prompt gate.
  const [head, ...rest] = key.split(".");
  if (head === "tool" && rest.length) return applyGate(p.tool, rest.join("."), value, "tool.");
  if (head === "prompt" && rest.length) return applyGate(p.prompt, rest.join("."), value, "prompt.");
  if (head === "lane" && rest.length) return applyGate(p.lane, rest.join("."), value, "lane.");
  if (head === "choice" && rest.length) return applyGate(p.choice, rest.join("."), value, "choice.");

  switch (key) {
    case "interrupt":
      if (!["anyone", "owner", "proposer"].includes(value)) return `interrupt must be anyone|owner|proposer`;
      p.interrupt = value as RoomPolicy["interrupt"];
      return null;
    case "merge":
    case "mergeQueued":
      p.mergeQueued = truthy(value);
      return null;
    case "attribute":
      p.attribute = truthy(value);
      return null;
    case "autoAllow": {
      if (value === "none" || value === "") {
        p.autoAllowToolRisks = [];
        return null;
      }
      const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = parts.filter((s) => !RISKS.includes(s as ToolRisk));
      if (bad.length) return `autoAllow: unknown risk ${bad.join(",")} (want read|write|exec)`;
      p.autoAllowToolRisks = parts as ToolRisk[];
      return null;
    }
    default:
      return applyGate(p.prompt, key, value, "");
  }
}

function applyGate(g: GatePolicy, key: string, value: string, prefix: string): string | null {
  switch (key) {
    case "mode": {
      const modes = ["open", "owner", "majority", "quorum", "consensus", "round-robin"];
      if (!modes.includes(value)) return `${prefix}mode must be one of ${modes.join("|")}`;
      g.mode = value as GatePolicy["mode"];
      return null;
    }
    case "quorum": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) return `${prefix}quorum must be a positive integer`;
      g.quorum = n;
      return null;
    }
    case "veto":
      g.veto = truthy(value);
      return null;
    case "timeout":
    case "autoApproveMs": {
      if (value === "off" || value === "none" || value === "null") {
        g.autoApproveMs = null;
        return null;
      }
      const ms = parseDuration(value);
      if (ms === null) return `${prefix}timeout must be a duration like 30s, 2m, or "off"`;
      g.autoApproveMs = ms;
      return null;
    }
    case "minYes": {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) return `${prefix}minYes must be a non-negative integer`;
      g.minYesOnTimeout = n;
      return null;
    }
    case "proposerAutoYes":
      g.proposerAutoYes = truthy(value);
      return null;
    case "soloBypass":
      g.soloBypass = truthy(value);
      return null;
    default:
      return `unknown policy key "${prefix}${key}"`;
  }
}

function truthy(v: string): boolean {
  return ["1", "true", "yes", "on", "y"].includes(v.toLowerCase());
}

/** `45`, `45s`, `2m`, `1h` -> milliseconds. Bare numbers are seconds. */
export function parseDuration(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch (m[2]) {
    case "ms":
      return Math.round(n);
    case "m":
      return Math.round(n * 60_000);
    case "h":
      return Math.round(n * 3_600_000);
    default:
      return Math.round(n * 1000);
  }
}

/** Compact one-line rendering for the status bar, e.g. `majority+veto 45s`. */
export function describeGate(g: GatePolicy): string {
  let s: string = g.mode;
  if (g.mode === "quorum") s += `(${g.quorum})`;
  if (g.veto && g.mode !== "consensus") s += "+veto";
  if (g.autoApproveMs) s += ` ${Math.round(g.autoApproveMs / 1000)}s`;
  return s;
}
