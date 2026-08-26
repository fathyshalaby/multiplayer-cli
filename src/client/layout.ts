import type { CrossroadsInfo, LaneInfo } from "../protocol.js";
import { describeGate } from "../core/policy.js";
import * as c from "../util/ansi.js";
import { previewNote } from "./roomView.js";
import type { LogEntry, ProposalCard, ViewState } from "./roomView.js";

/**
 * The screen, as a pure function of the room.
 *
 * `render` returns exactly `rows` lines of exactly `cols` visible columns, and
 * touches nothing — no cursor, no stdout, no clock beyond the one handed in.
 * Everything about how a room *looks* is therefore testable by reading strings,
 * which is the only way terminal layout ever gets checked properly.
 */

export interface Size {
  cols: number;
  rows: number;
}

export interface Frame {
  lines: string[];
  /** Where the terminal cursor belongs, 0-indexed. */
  cursor: { row: number; col: number };
}

export interface InputLine {
  text: string;
  cursor: number;
}

export interface RenderOptions {
  view: ViewState;
  input: InputLine;
  /** Lines scrolled back from the newest output. 0 is pinned to the bottom. */
  scroll: number;
  /** Transient line under the input: a completion list, a local error. */
  hint?: string;
  now: number;
}

/** Below this there is not enough room for panes; the caller uses plain mode. */
export const MIN_COLS = 60;
export const MIN_ROWS = 14;
/** The sidebar is dropped below this, and the transcript gets the whole width. */
export const SIDEBAR_AT = 84;
const SIDEBAR_COLS = 32;

export function render(size: Size, opts: RenderOptions): Frame {
  const { cols, rows } = size;
  const sidebar = cols >= SIDEBAR_AT ? SIDEBAR_COLS : 0;
  const mainCols = sidebar ? cols - sidebar - 1 : cols;

  const header = headerLines(opts.view, cols);
  const footer = footerLines(opts, cols);
  const bodyRows = Math.max(1, rows - header.length - footer.lines.length);

  const main = transcript(opts, mainCols, bodyRows);
  const side = sidebar ? sidePane(opts, sidebar, bodyRows) : [];

  const body: string[] = [];
  for (let i = 0; i < bodyRows; i++) {
    const left = pad(main[i] ?? "", mainCols);
    if (!sidebar) {
      body.push(left);
      continue;
    }
    body.push(`${left}${c.dim("│")}${pad(side[i] ?? "", sidebar)}`);
  }

  const lines = [...header, ...body, ...footer.lines];
  return {
    lines: lines.slice(0, rows).map((l) => pad(l, cols)),
    cursor: { row: header.length + bodyRows + footer.cursorRow, col: footer.cursorCol },
  };
}

/* ------------------------------------------------------------------ */
/* header                                                              */
/* ------------------------------------------------------------------ */

function headerLines(v: ViewState, cols: number): string[] {
  const left = [
    c.bold(c.cyan(v.room || "connecting…")),
    v.backend ? c.dim(v.backend + (v.model ? `/${v.model}` : "")) : "",
    v.gate ? c.dim(v.gate) : "",
  ]
    .filter(Boolean)
    .join(c.dim("  ·  "));

  const seats = v.participants.length;
  const right = [
    `${seats} seat${seats === 1 ? "" : "s"}`,
    v.connected ? (v.encrypted ? "encrypted" : c.yellow("unencrypted")) : c.red("offline"),
  ].join(c.dim(" · "));

  return [spread(left, c.dim(right), cols), c.dim("─".repeat(cols))];
}

/* ------------------------------------------------------------------ */
/* the transcript pane                                                 */
/* ------------------------------------------------------------------ */

function transcript(opts: RenderOptions, cols: number, rows: number): string[] {
  const wrapped: string[] = [];
  for (const entry of opts.view.log) wrapped.push(...entryLines(entry, cols));

  // `scroll` counts lines back from the newest, so a room that keeps talking
  // does not drag the reader along while they are looking at something.
  const end = Math.max(0, wrapped.length - opts.scroll);
  const start = Math.max(0, end - rows);
  const page = wrapped.slice(start, end);

  const out = page.length < rows ? [...Array(rows - page.length).fill(""), ...page] : page;
  if (opts.scroll > 0 && out.length) {
    out[0] = c.dim(`↑ ${opts.scroll} more line${opts.scroll === 1 ? "" : "s"} below — PgDn to catch up`);
  }
  return out;
}

function entryLines(entry: LogEntry, cols: number): string[] {
  const width = Math.max(8, cols - 2);
  switch (entry.kind) {
    case "model":
      return c.wrapText(entry.text, width - 2).map((l) => `${c.magenta("│")} ${l}`);
    case "chat": {
      const paint = c.participantColor(entry.color);
      const head = `${c.dim("💬")} ${paint(entry.who)}${c.dim(":")} `;
      const body = c.wrapText(entry.text, width - c.width(head));
      return body.map((l, i) => (i === 0 ? `${head}${l}` : `   ${l}`));
    }
    case "turn": {
      const head = `── ${entry.text} `;
      return [c.dim(head + "─".repeat(Math.max(0, cols - head.length)))];
    }
    case "raw":
      return [c.truncate(entry.text, cols)];
    case "tool":
      return c.wrapText(entry.text, width).map((l) => c.dim(`  ${l}`));
    case "notice":
    default:
      return c.wrapText(entry.text, width).map((l) => c.dim(`  ${l}`));
  }
}

/* ------------------------------------------------------------------ */
/* the sidebar                                                         */
/* ------------------------------------------------------------------ */

function sidePane(opts: RenderOptions, cols: number, rows: number): string[] {
  const v = opts.view;
  const out: string[] = [];
  const inner = cols - 1;

  out.push(...section("room", roster(v, inner)));

  // Oldest first, because an overflowing sidebar drops from the top: listing
  // newest-first would cut off the vote that just arrived, which is the one
  // nobody can afford to miss. It also puts lane votes in lane order.
  // The fork goes above the votes on it: the question is the thing that has to
  // be read before the options mean anything.
  const fork = v.crossroads?.state === "open" ? v.crossroads : null;
  if (fork) out.push("", ...section("the fork", forkBlock(fork, inner)));

  const open = v.proposals.filter((p) => p.open).slice().reverse();
  if (open.length) out.push("", ...section("deciding", open.flatMap((p) => voteBlock(p, inner))));
  if (v.queued.length) out.push("", ...section("queued", [c.dim(`${v.queued.length} waiting for the model`)]));
  if (v.lanes.length) out.push("", ...section("lanes", v.lanes.flatMap((l) => laneBlock(l, inner))));
  if (v.runners.length > 1) out.push("", ...section("accounts", runnerLines(v, inner)));

  // The sidebar is a summary, not a scrolling region: when there is more than
  // fits, the oldest sections go rather than the newest, because what is
  // waiting on you now is what you need to see.
  const body = out.length > rows ? out.slice(out.length - rows) : out;
  return body.map((l) => " " + c.truncate(l, inner));
}

function section(title: string, body: string[]): string[] {
  return [c.dim(title.toUpperCase()), ...body];
}

function roster(v: ViewState, cols: number): string[] {
  return v.participants.map((p) => {
    const paint = c.participantColor(p.color);
    const marks = [
      p.role === "owner" ? "host" : p.role === "observer" ? "obs" : "",
      p.id === v.micHolderId && v.policy.prompt.mode === "round-robin" ? "mic" : "",
      p.id === v.youId ? "you" : "",
    ].filter(Boolean);
    const line = `${paint(p.connected ? "●" : "○")} ${p.name}`;
    const tail = marks.length ? c.dim(` ${marks.join(" ")}`) : "";
    return c.truncate(line + tail, cols);
  });
}

function voteBlock(card: ProposalCard, cols: number): string[] {
  const p = card.proposal;
  const mark =
    p.kind === "tool"
      ? c.yellow("⚙")
      : p.kind === "lane"
        ? c.green("⚑")
        : p.kind === "choice"
          ? c.blue("⑂")
          : c.cyan("▸");
  const label =
    p.kind === "prompt"
      ? p.authorName
      : p.kind === "lane"
        ? `lane ${p.lane}`
        : p.kind === "choice"
          ? "direction"
          : "tool";
  const head = `${mark} ${c.bold(p.id)} ${c.dim(label)}`;
  const text = c.truncate(p.text.replace(/\s+/g, " "), cols - 2);
  return [head, `  ${text}`, `  ${c.dim(card.progress)}`];
}

function forkBlock(f: CrossroadsInfo, cols: number): string[] {
  return [
    ...c.wrapText(f.question, cols).map((l) => c.bold(l)),
    ...(f.blocking ? [c.dim("the turn is paused on this")] : []),
  ];
}

function laneBlock(l: LaneInfo, cols: number): string[] {
  const mark =
    l.state === "running"
      ? c.cyan("▸")
      : l.state === "done"
        ? c.green("✓")
        : l.state === "landed"
          ? c.green("⚑")
          : l.state === "failed"
            ? c.red("✗")
            : c.gray("·");
  const what =
    l.state === "running"
      ? "running"
      : l.state === "empty"
        ? "no changes"
        : l.state === "failed"
          ? (l.error ?? "failed")
          : l.summary;
  const lines = [c.truncate(`${mark} ${c.bold(l.id)} ${c.dim(what)}`, cols)];
  const note = previewNote(l);
  // Indented under its lane: the URL belongs to that lane and a flat list of
  // ports beside a flat list of lanes is a puzzle nobody wants during a vote.
  if (note) {
    const paint = l.preview?.state === "ready" ? c.cyan : l.preview?.state === "failed" ? c.red : c.dim;
    lines.push(c.truncate(`  ${paint(note)}`, cols));
  }
  return lines;
}

function runnerLines(v: ViewState, cols: number): string[] {
  return v.runners.map((r) => {
    const mark = r.id === v.activeRunnerId ? c.green("▸") : r.exhausted ? c.red("○") : c.dim("·");
    return c.truncate(`${mark} ${r.name} ${c.dim(r.backend)}`, cols);
  });
}

/* ------------------------------------------------------------------ */
/* input and status                                                    */
/* ------------------------------------------------------------------ */

function footerLines(
  opts: RenderOptions,
  cols: number,
): { lines: string[]; cursorRow: number; cursorCol: number } {
  const v = opts.view;
  const prompt = `${c.participantColor(colorOf(v))(v.youName || "you")} ${c.bold("❯")} `;
  const promptWidth = c.width(prompt);
  const room = Math.max(4, cols - promptWidth);

  // Scroll the text under a fixed prompt rather than wrapping it: a proposal
  // can be long, and a growing input area would push the transcript around
  // while somebody is still deciding what to type.
  const from = Math.max(0, opts.input.cursor - room + 1);
  const visible = opts.input.text.slice(from, from + room);
  const cursorCol = promptWidth + (opts.input.cursor - from);

  const lines = [c.dim("─".repeat(cols)), `${prompt}${visible}`];
  const cursorRow = 1;
  lines.push(opts.hint ? c.truncate(c.dim(opts.hint), cols) : statusLine(opts, cols));
  return { lines, cursorRow, cursorCol };
}

function statusLine(opts: RenderOptions, cols: number): string {
  const v = opts.view;
  const bits: string[] = [];
  if (!v.connected) bits.push(c.red("reconnecting…"));
  if (v.agent !== "idle") {
    bits.push(c.magenta(v.agent + (v.agentDetail ? ` ${c.dim(v.agentDetail)}` : "")));
  }
  const open = v.proposals.filter((p) => p.open).length;
  if (open) bits.push(c.yellow(`${open} awaiting a decision`));
  if (!bits.length) {
    bits.push(c.dim("type to propose · /y approve · /n veto · /help"));
  }
  const right = c.dim(`${v.turnCount} turn${v.turnCount === 1 ? "" : "s"}`);
  return spread(bits.join(c.dim("  ·  ")), right, cols);
}

function colorOf(v: ViewState): number {
  return v.participants.find((p) => p.id === v.youId)?.color ?? 0;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Left text, right text, and whatever space is left in between. */
export function spread(left: string, right: string, cols: number): string {
  const lw = c.width(left);
  const rw = c.width(right);
  if (lw + rw + 1 > cols) return pad(c.truncate(left, cols), cols);
  return left + " ".repeat(cols - lw - rw) + right;
}

/** Exactly `cols` visible columns: padded if short, truncated if long. */
export function pad(s: string, cols: number): string {
  const w = c.width(s);
  if (w === cols) return s;
  if (w < cols) return s + " ".repeat(cols - w);
  return c.truncate(s, cols);
}

/** Whether a terminal this size can show the full-screen layout at all. */
export function fits(size: Size): boolean {
  return size.cols >= MIN_COLS && size.rows >= MIN_ROWS;
}

export function describeRoomGate(v: ViewState): string {
  return describeGate(v.policy.prompt);
}
