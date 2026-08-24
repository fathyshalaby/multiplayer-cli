const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY || process.env.FORCE_COLOR !== undefined);

function wrap(open: string, close: string) {
  return (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const colorEnabled = enabled;

export const bold = wrap("1", "22");
export const dim = wrap("2", "22");
export const italic = wrap("3", "23");
export const underline = wrap("4", "24");
export const inverse = wrap("7", "27");

export const red = wrap("31", "39");
export const green = wrap("32", "39");
export const yellow = wrap("33", "39");
export const blue = wrap("34", "39");
export const magenta = wrap("35", "39");
export const cyan = wrap("36", "39");
export const gray = wrap("90", "39");

/** Stable per-participant colors so everyone renders the room identically. */
const PALETTE = [36, 35, 32, 33, 34, 91, 92, 93, 94, 95, 96];

export function participantColor(idx: number): (s: string) => string {
  const code = PALETTE[idx % PALETTE.length]!;
  return (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[39m` : s);
}

export function paletteSize(): number {
  return PALETTE.length;
}

/** Visible width, ignoring escape sequences. */
export function width(s: string): number {
  return stripAnsi(s).length;
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

export function truncate(s: string, max: number): string {
  const plain = stripAnsi(s);
  if (plain.length <= max) return s;
  return plain.slice(0, Math.max(0, max - 1)) + "…";
}

/** Wrap text to a width, preserving existing newlines. */
export function wrapText(s: string, max: number, indent = ""): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    if (para.length <= max) {
      out.push(indent + para);
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!line.length) line = word;
      else if (line.length + 1 + word.length <= max) line += " " + word;
      else {
        out.push(indent + line);
        line = word;
      }
    }
    if (line.length) out.push(indent + line);
  }
  return out;
}
