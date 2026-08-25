import type { Frame } from "./layout.js";

/**
 * Puts a frame on the terminal, rewriting only the lines that changed.
 *
 * A full repaint every keystroke is what makes a terminal UI flicker and what
 * makes it unusable over ssh. Keeping the previous frame and sending only the
 * differences costs a comparison per line and turns a 3KB repaint into a few
 * dozen bytes for the common case of one character being typed.
 *
 * The writer is injected, so all of this is testable without a terminal.
 */

export interface Writer {
  write(s: string): void;
}

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const CLEAR = "\x1b[2J\x1b[H";

export class Screen {
  private out: Writer;
  private previous: string[] = [];
  private active = false;
  /** Counts the bytes written, so tests can assert that a redraw was cheap. */
  bytes = 0;

  constructor(out: Writer) {
    this.out = out;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    this.previous = [];
    this.emit(ALT_ON + HIDE + CLEAR);
  }

  /** Give the terminal back exactly as it was found. */
  leave(): void {
    if (!this.active) return;
    this.active = false;
    this.previous = [];
    this.emit(SHOW + ALT_OFF);
  }

  /** Force the next draw to repaint everything, e.g. after a resize. */
  invalidate(): void {
    this.previous = [];
    if (this.active) this.emit(CLEAR);
  }

  draw(frame: Frame): void {
    if (!this.active) return;
    let buf = HIDE;
    const rows = Math.max(frame.lines.length, this.previous.length);
    for (let i = 0; i < rows; i++) {
      const next = frame.lines[i] ?? "";
      if (this.previous[i] === next) continue;
      buf += `\x1b[${i + 1};1H\x1b[2K${next}`;
    }
    buf += `\x1b[${frame.cursor.row + 1};${frame.cursor.col + 1}H${SHOW}`;
    this.previous = [...frame.lines];
    this.emit(buf);
  }

  private emit(s: string): void {
    this.bytes += s.length;
    this.out.write(s);
  }

  get entered(): boolean {
    return this.active;
  }
}
