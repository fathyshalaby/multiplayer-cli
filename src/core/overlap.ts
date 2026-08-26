/**
 * Where two lanes touched the same file.
 *
 * This only matters for a split. In a race the lanes are *substitutes* — three
 * attempts at one thing, of which the room takes one — so of course they
 * overlap, and saying so would be noise. In a split they are *complements*:
 * different work, meant to land together. Two of them editing the same file is
 * either duplicated effort or a merge conflict the room has not met yet, and
 * both are worth saying out loud before anyone votes.
 *
 * It is deliberately only a warning. Two lanes touching one file is often
 * correct — a route and its test, an interface and an implementation — and a
 * tool that refuses to proceed on a heuristic is a tool people route around.
 */

export interface Overlap {
  path: string;
  /** Lane ids, in the order the lanes were given. */
  lanes: string[];
}

export interface LanePaths {
  id: string;
  paths: string[];
}

/**
 * Files claimed by more than one lane, most contested first.
 *
 * Ties break on the path so the same set of lanes always reads the same way —
 * a warning that reshuffles itself between runs is one people stop believing.
 */
export function findOverlaps(lanes: LanePaths[]): Overlap[] {
  const byPath = new Map<string, string[]>();
  for (const lane of lanes) {
    // A lane that names a path twice must not look like two lanes.
    for (const path of new Set(lane.paths)) {
      const seen = byPath.get(path);
      if (seen) seen.push(lane.id);
      else byPath.set(path, [lane.id]);
    }
  }

  const out: Overlap[] = [];
  for (const [path, ids] of byPath) {
    if (ids.length > 1) out.push({ path, lanes: ids });
  }
  out.sort((a, b) => b.lanes.length - a.lanes.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** How many paths to name before the warning becomes a wall of text. */
const SHOWN = 4;

/**
 * The overlap warning as the room hears it, or null when there is nothing to say.
 *
 * One line. It is a caveat on a vote that is about to happen, not a report, and
 * a room reading five lines of preamble is a room that has stopped reading.
 */
export function describeOverlaps(overlaps: Overlap[]): string | null {
  if (!overlaps.length) return null;
  const shown = overlaps.slice(0, SHOWN).map((o) => `${o.path} (${o.lanes.join(", ")})`);
  const rest = overlaps.length - shown.length;
  const tail = rest > 0 ? `, and ${rest} more file${rest === 1 ? "" : "s"}` : "";
  return `lanes overlap: ${shown.join("; ")}${tail} — landing both may conflict`;
}
