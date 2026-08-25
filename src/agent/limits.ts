/**
 * Recognising "this account is out of capacity" across tools that all phrase it
 * differently — and none of which expose it as a structured field.
 *
 * A false positive costs a needless handoff; a false negative strands the room
 * on an account that cannot answer. Patterns are kept narrow for that reason:
 * a plain failure should stay a plain failure.
 */
const LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /rate[- ]limited/i,
  /too many requests/i,
  /\b429\b/,
  /quota (?:exceeded|reached|exhausted)/i,
  /out of (?:credit|credits|tokens)/i,
  /insufficient (?:credit|credits|quota|balance)/i,
  /(?:credit|usage) balance is too low/i,
  /you(?:'ve| have) (?:reached|hit) your .{0,40}limit/i,
  /capacity (?:constraints|exceeded)/i,
  /overloaded/i,
];

export function looksLimited(text: string | undefined | null): boolean {
  if (!text) return false;
  return LIMIT_PATTERNS.some((re) => re.test(text));
}

/**
 * Pull a reset time out of the message when the tool volunteers one, so the
 * room can put the runner back rather than writing it off for the session.
 */
export function resetsAt(text: string | undefined | null, now = Date.now()): number | null {
  if (!text) return null;

  const inUnits = /(?:try again|retry|resets?|available again) in (\d+)\s*(second|minute|hour)s?/i.exec(text);
  if (inUnits) {
    const n = Number(inUnits[1]);
    const unit = inUnits[2]!.toLowerCase();
    const ms = unit === "second" ? 1000 : unit === "minute" ? 60_000 : 3_600_000;
    return now + n * ms;
  }

  const retryAfter = /retry[- ]after[:= ]\s*(\d+)/i.exec(text);
  if (retryAfter) return now + Number(retryAfter[1]) * 1000;

  // "resets at 3pm", "resets at 15:00" — resolve to the next such wall-clock time.
  const at = /(?:resets?|available again|try again)\s*(?:at|after)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (at) {
    let hour = Number(at[1]);
    const minute = at[2] ? Number(at[2]) : 0;
    const mer = at[3]?.toLowerCase();
    if (mer === "pm" && hour < 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
    const d = new Date(now);
    d.setSeconds(0, 0);
    d.setHours(hour, minute);
    let t = d.getTime();
    if (t <= now) t += 24 * 3_600_000;
    return t;
  }
  return null;
}

/** Annotate a failed turn with whether it was a capacity problem. */
export function classify<T extends { error?: string; stopReason: string }>(
  result: T,
  now = Date.now(),
): T & { limited?: boolean; until?: number | null } {
  if (!result.error || !looksLimited(result.error)) return result;
  return { ...result, limited: true, until: resetsAt(result.error, now) };
}
