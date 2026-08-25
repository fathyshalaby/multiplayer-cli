/**
 * The input line, as a pure function of keystrokes.
 *
 * A full-screen seat cannot use readline: readline owns the cursor and the
 * bottom of the screen, which is exactly what the layout needs back. So the
 * editing behaviour people expect from a shell lives here instead — and being
 * pure, it can be tested by handing it keys, with no terminal anywhere.
 */

/** The shape node's `keypress` events arrive in. */
export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

export interface EditorState {
  text: string;
  /** Insertion point, in characters, 0..text.length. */
  cursor: number;
  history: string[];
  /**
   * Where we are in history: `history.length` means "not browsing". Anything
   * lower is an entry being shown.
   */
  histIdx: number;
  /** What was being typed before history browsing started, to come back to. */
  draft: string;
}

export type EditorAction =
  | { kind: "none" }
  | { kind: "submit"; text: string }
  /** Ctrl-C: stop the model, or leave if nothing is running. The caller decides. */
  | { kind: "interrupt" }
  | { kind: "quit" }
  /** Positive scrolls back into history, negative towards the newest output. */
  | { kind: "scroll"; delta: number }
  | { kind: "redraw" }
  /** Tab found more than one candidate; the caller shows them. */
  | { kind: "suggest"; options: string[] };

export interface EditorOptions {
  /** Candidate completions for the line so far. */
  complete?: (line: string) => string[];
  /** Lines of scrollback a page key moves. */
  page?: number;
}

const HISTORY_MAX = 300;

export function newEditor(history: string[] = []): EditorState {
  return { text: "", cursor: 0, history: [...history], histIdx: history.length, draft: "" };
}

/**
 * Apply one keystroke.
 *
 * Returns a new state and whatever the caller has to act on. Nothing here
 * writes, sends or exits — a keystroke's meaning and its consequence are kept
 * apart so the meaning can be tested on its own.
 */
export function applyKey(
  state: EditorState,
  str: string | undefined,
  key: Key,
  opts: EditorOptions = {},
): { state: EditorState; action: EditorAction } {
  const s = { ...state };
  const page = opts.page ?? 10;
  const none = (next: EditorState): { state: EditorState; action: EditorAction } => ({
    state: next,
    action: { kind: "none" },
  });

  if (key.ctrl) {
    switch (key.name) {
      case "c":
        return { state: s, action: { kind: "interrupt" } };
      case "d":
        // Only on an empty line, so it cannot swallow a half-typed proposal.
        if (!s.text) return { state: s, action: { kind: "quit" } };
        return none(deleteRight(s));
      case "a":
        s.cursor = 0;
        return none(s);
      case "e":
        s.cursor = s.text.length;
        return none(s);
      case "b":
        s.cursor = Math.max(0, s.cursor - 1);
        return none(s);
      case "f":
        s.cursor = Math.min(s.text.length, s.cursor + 1);
        return none(s);
      case "k":
        s.text = s.text.slice(0, s.cursor);
        return none(s);
      case "u":
        s.text = s.text.slice(s.cursor);
        s.cursor = 0;
        return none(s);
      case "w":
        return none(deleteWordLeft(s));
      case "l":
        return { state: s, action: { kind: "redraw" } };
      default:
        return none(s);
    }
  }

  switch (key.name) {
    case "return":
    case "enter": {
      const text = s.text;
      const next = newEditor(remember(s.history, text));
      return { state: next, action: { kind: "submit", text } };
    }
    case "backspace":
      return none(deleteLeft(s));
    case "delete":
      return none(deleteRight(s));
    case "left":
      s.cursor = Math.max(0, s.cursor - 1);
      return none(s);
    case "right":
      s.cursor = Math.min(s.text.length, s.cursor + 1);
      return none(s);
    case "home":
      s.cursor = 0;
      return none(s);
    case "end":
      s.cursor = s.text.length;
      return none(s);
    case "up":
      return none(browse(s, -1));
    case "down":
      return none(browse(s, 1));
    case "pageup":
      return { state: s, action: { kind: "scroll", delta: page } };
    case "pagedown":
      return { state: s, action: { kind: "scroll", delta: -page } };
    case "tab":
      return complete(s, opts);
    case "escape":
      return none(s);
    default:
      break;
  }

  // Anything that produced a printable character is typing. Control sequences
  // arrive with a `name` and are handled above, so what reaches here is text.
  if (str && !key.ctrl && !key.meta && str >= " " && str !== "\x7f") {
    s.text = s.text.slice(0, s.cursor) + str + s.text.slice(s.cursor);
    s.cursor += str.length;
    // Typing abandons history browsing: what is on the line is now the draft,
    // whether it started as a recalled entry or not.
    s.histIdx = s.history.length;
    s.draft = s.text;
    return none(s);
  }
  return none(s);
}

function complete(s: EditorState, opts: EditorOptions): { state: EditorState; action: EditorAction } {
  const options = opts.complete?.(s.text) ?? [];
  if (!options.length) return { state: s, action: { kind: "none" } };
  const prefix = commonPrefix(options);
  if (prefix.length > s.text.length) {
    const next = { ...s, text: prefix, cursor: prefix.length };
    // A single candidate is a finished word; leave a space so the next thing
    // typed is an argument rather than more of the command.
    if (options.length === 1) {
      next.text = prefix + " ";
      next.cursor = next.text.length;
      return { state: next, action: { kind: "none" } };
    }
    return { state: next, action: { kind: "suggest", options } };
  }
  return { state: s, action: options.length > 1 ? { kind: "suggest", options } : { kind: "none" } };
}

function browse(s: EditorState, dir: -1 | 1): EditorState {
  if (!s.history.length) return s;
  // Already at the newest line: there is nothing newer to go to, and moving
  // anyway would replace what is being typed with a stale draft.
  if (dir === 1 && s.histIdx >= s.history.length) return s;
  const next = { ...s };
  if (s.histIdx === s.history.length && dir === -1) next.draft = s.text;
  const idx = Math.max(0, Math.min(s.history.length, s.histIdx + dir));
  next.histIdx = idx;
  next.text = idx === s.history.length ? next.draft : s.history[idx]!;
  next.cursor = next.text.length;
  return next;
}

function deleteLeft(s: EditorState): EditorState {
  if (!s.cursor) return s;
  return { ...s, text: s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), cursor: s.cursor - 1 };
}

function deleteRight(s: EditorState): EditorState {
  if (s.cursor >= s.text.length) return s;
  return { ...s, text: s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1) };
}

function deleteWordLeft(s: EditorState): EditorState {
  if (!s.cursor) return s;
  let i = s.cursor;
  while (i > 0 && s.text[i - 1] === " ") i--;
  while (i > 0 && s.text[i - 1] !== " ") i--;
  return { ...s, text: s.text.slice(0, i) + s.text.slice(s.cursor), cursor: i };
}

/** Newest last. A repeat of the previous line does not earn a second entry. */
export function remember(history: string[], line: string): string[] {
  const text = line.trim();
  if (!text) return history;
  if (history[history.length - 1] === text) return history;
  return [...history, text].slice(-HISTORY_MAX);
}

export function commonPrefix(items: string[]): string {
  if (!items.length) return "";
  let prefix = items[0]!;
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}
