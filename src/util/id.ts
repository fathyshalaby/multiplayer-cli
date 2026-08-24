import { randomBytes } from "node:crypto";

const ADJECTIVES = [
  "amber", "brisk", "calm", "dusk", "ember", "fern", "glint", "hazel",
  "iron", "jade", "kelp", "lunar", "moss", "north", "onyx", "pine",
  "quartz", "rust", "slate", "tidal", "umber", "vale", "wren", "zinc",
];
const NOUNS = [
  "atlas", "beacon", "cinder", "delta", "echo", "forge", "grove", "harbor",
  "inlet", "junction", "kiln", "lantern", "meridian", "nexus", "orbit", "prism",
  "quarry", "ridge", "summit", "thicket", "union", "vertex", "willow", "zenith",
];

/** Short, pronounceable room name — easier to read out loud than a UUID. */
export function roomName(): string {
  const a = pick(ADJECTIVES);
  const n = pick(NOUNS);
  const d = randomBytes(1)[0]! % 100;
  return `${a}-${n}-${String(d).padStart(2, "0")}`;
}

function pick<T>(arr: T[]): T {
  return arr[randomBytes(1)[0]! % arr.length]!;
}

export function id(prefix: string, len = 8): string {
  return `${prefix}_${randomBytes(len).toString("base64url").slice(0, len)}`;
}

/** URL-safe shared secret for joining a room. */
export function token(): string {
  return randomBytes(18).toString("base64url");
}

/** Short human-quotable proposal handles: #1, #2, ... per room. */
export class Counter {
  private n = 0;
  next(): string {
    this.n += 1;
    return `#${this.n}`;
  }
  get value(): number {
    return this.n;
  }
}
