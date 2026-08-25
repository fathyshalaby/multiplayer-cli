/**
 * A fork in the road, put to the room.
 *
 * The room's other gates all run in one direction: people interrupting the
 * agent to approve a prompt, a tool call, or a finished diff. This is the
 * other direction — the agent stopping at a genuine fork and asking which way
 * to go, before it spends the work.
 *
 * That makes it the cheapest vote in the system. Racing answers "which
 * approach" by building all of them; this answers it by asking, which is the
 * only thing that works when the fork is about intent rather than code — "must
 * v1 keep working?" is a decision, and no amount of running the code settles
 * it.
 */

export interface ParsedOption {
  label: string;
  detail?: string;
}

export interface ParsedCrossroads {
  question: string;
  options: ParsedOption[];
}

/** Bounds, so a confused model cannot put twenty things to a vote. */
export const MAX_OPTIONS = 6;
export const MIN_OPTIONS = 2;
export const MAX_QUESTION = 300;
export const MAX_LABEL = 120;

const OPEN = "[[crossroads]]";
const CLOSE = "[[/crossroads]]";

/**
 * The block a model writes to raise one.
 *
 * Deliberately not JSON: it has to survive being typed by a model that is
 * streaming prose, and a missing brace should not silently swallow the
 * question. Line-oriented text degrades into something a person can still read
 * if the parse fails.
 */
export const CROSSROADS_SYNTAX = [
  OPEN,
  "? <the decision, in one line>",
  "- <option> — <why you would pick it>",
  "- <option> — <why you would pick it>",
  CLOSE,
].join("\n");

/** What the model is told about it, when the room can carry a crossroads. */
export function crossroadsInstruction(): string {
  return [
    "If you reach a genuine fork — two or more defensible directions, where picking wrong means redoing the work — stop and put it to the room instead of choosing silently:",
    "",
    CROSSROADS_SYNTAX,
    "",
    `Between ${MIN_OPTIONS} and ${MAX_OPTIONS} options, each a real course of action rather than a restatement of the question. Then stop and wait; the room's answer arrives as your next message.`,
    "Use it for decisions that are the room's to make — product intent, compatibility, scope. Do not use it for things you can simply look up in the repository.",
  ].join("\n");
}

/**
 * Pull every complete block out of a chunk of text.
 *
 * Returns what it found and the text with the blocks removed, so the caller
 * can show the room the prose without the machinery in the middle of it.
 */
export function extractCrossroads(text: string): { found: ParsedCrossroads[]; rest: string } {
  const found: ParsedCrossroads[] = [];
  let rest = "";
  let cursor = 0;

  for (;;) {
    const open = text.indexOf(OPEN, cursor);
    if (open < 0) break;
    const close = text.indexOf(CLOSE, open + OPEN.length);
    if (close < 0) break;

    const body = text.slice(open + OPEN.length, close);
    const parsed = parseBody(body);
    if (parsed) {
      found.push(parsed);
      rest += text.slice(cursor, open);
      // The block sat on its own lines. Removing it would otherwise leave the
      // hole behind as blank lines in the middle of the model's prose.
      cursor = eatOneNewline(text, close + CLOSE.length);
      continue;
    } else {
      // Malformed: leave it in the transcript rather than eating it, so the
      // room can see what the model was trying to say.
      rest += text.slice(cursor, close + CLOSE.length);
    }
    cursor = close + CLOSE.length;
  }
  rest += text.slice(cursor);
  return { found, rest };
}

function parseBody(body: string): ParsedCrossroads | null {
  let question = "";
  const options: ParsedOption[] = [];

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (!question && line.startsWith("?")) {
      question = clamp(line.slice(1).trim(), MAX_QUESTION);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const opt = splitOption(bullet[1]!.trim());
    if (opt) options.push(opt);
  }

  if (!question || options.length < MIN_OPTIONS) return null;
  return { question, options: options.slice(0, MAX_OPTIONS) };
}

/**
 * `Shim it — keep v1 working` splits into a label and why you would pick it.
 *
 * A dash has to be surrounded by spaces or `well-known` becomes two things; a
 * colon does not, because nobody writes one with a space in front of it.
 */
function splitOption(s: string): ParsedOption | null {
  if (!s) return null;
  const m = /^(.*?)(?:\s+(?:—|--|–)\s+|:\s+)(.*)$/.exec(s);
  if (m && m[1]!.trim()) {
    return { label: clamp(m[1]!.trim(), MAX_LABEL), detail: clamp(m[2]!.trim(), MAX_QUESTION) };
  }
  return { label: clamp(s, MAX_LABEL) };
}

function clamp(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/**
 * Finds blocks in a stream that arrives a token at a time.
 *
 * A block spans many deltas, so nothing can be decided from one of them. This
 * holds back only what might still turn out to be a block — everything from an
 * unmatched opener onwards — and releases the rest immediately, so the room
 * still watches the model write in real time.
 */
export class CrossroadsStream {
  private buffer = "";

  /** Feed a delta. Returns text safe to display now, and any complete blocks. */
  push(delta: string): { text: string; found: ParsedCrossroads[] } {
    this.buffer += delta;
    const { found, rest } = extractCrossroads(this.buffer);

    // Hold back from the last unmatched opener, or from a trailing fragment
    // that could still become one.
    const open = rest.lastIndexOf(OPEN);
    const hold = open >= 0 ? open : partialOpenAt(rest);
    if (hold >= 0) {
      this.buffer = rest.slice(hold);
      return { text: rest.slice(0, hold), found };
    }
    this.buffer = "";
    return { text: rest, found };
  }

  /** Release whatever is still held; a turn that ended mid-block has no block. */
  flush(): string {
    const out = this.buffer;
    this.buffer = "";
    return out;
  }
}

/** Step past a single newline (and any spaces before it) at `from`. */
function eatOneNewline(text: string, from: number): number {
  const m = /^[ \t]*\r?\n/.exec(text.slice(from));
  return m ? from + m[0].length : from;
}

/** Index of a trailing prefix of the opener, e.g. text ending in `[[cross`. */
function partialOpenAt(s: string): number {
  const max = Math.min(OPEN.length - 1, s.length);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(OPEN.slice(0, n))) return s.length - n;
  }
  return -1;
}
