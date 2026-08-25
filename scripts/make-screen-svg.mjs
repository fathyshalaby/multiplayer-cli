#!/usr/bin/env node
/**
 * Turn a recorded full-screen session into an animated SVG.
 *
 * The other generator reveals a transcript line by line, which is what the
 * plain seat does. The full-screen seat does not scroll — it repaints a fixed
 * grid in place — so a recording of it is a sequence of *frames*, and the
 * animation has to switch between whole screens rather than add lines.
 *
 * Frames are sampled where the session went quiet, because that is where a
 * person would have been reading. The input is a real capture: the demo cannot
 * drift from what the tool prints, because it is what the tool printed.
 *
 * Usage: make-screen-svg.mjs <out.raw> <timing.log> <out.svg> [--rows n] [--cols n]
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [rawPath, timingPath, outPath] = args.filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
if (!rawPath || !timingPath || !outPath) {
  console.error("usage: make-screen-svg.mjs <out.raw> <timing.log> <out.svg> [--rows n] [--cols n]");
  process.exit(1);
}

const ROWS = flag("rows", 30);
const COLS = flag("cols", 118);
/** A pause at least this long is somewhere a person was reading. */
const SETTLE = flag("settle", 0.45);
const MAX_FRAMES = flag("frames", 9);
/** Screen readers get told what happened, not that a picture is here. */
const LABEL =
  args.includes("--label")
    ? args[args.indexOf("--label") + 1]
    : "A recorded multiplayer-cli session: someone proposes a change, the agent stops at a fork and asks whether the v1 API should keep working, the room picks a direction, and the agent carries on from there.";
/** Seconds each frame is held. The last one gets a longer look. */
const DWELL = 2.6;
const FINAL_DWELL = 5.5;

/* ------------------------------------------------------------------ */
/* replay                                                              */
/* ------------------------------------------------------------------ */

/** What `Screen.draw` ends every completed frame with: park cursor, show it. */
const FRAME_END = "\x1b[?25h";

/** One cell: a character plus the SGR state that was active when written. */
const blankCell = () => ({ ch: " ", fg: null, bold: false, dim: false });

function newGrid() {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, blankCell));
}

/**
 * Replay the subset of escapes the renderer emits.
 *
 * Only what `Screen` actually writes is handled — absolute cursor moves, erase
 * line, erase screen, SGR — because anything else would be a sequence this
 * program has no recording of.
 */
/**
 * Replay the stream, taking a snapshot at every completed repaint.
 *
 * Frame boundaries come from the stream, not from the timing log: `script`
 * buffers its own reads, so its chunk boundaries have nothing to do with the
 * app's writes. The renderer ends every completed frame by parking the cursor
 * and showing it, and that is an exact marker.
 *
 * Timing is used only for how long each frame stayed on screen, which is what
 * separates "a person read this" from "somebody pressed a key".
 */
function replay(bytes, timing) {
  const grid = newGrid();
  const shots = [];
  let row = 0;
  let col = 0;
  let sgr = { fg: null, bold: false, dim: false };
  let pending = "";

  const decoder = new TextDecoder("utf-8");
  let cursor = 0;
  let clock = 0;

  for (const entry of timing) {
    const slice = bytes.subarray(cursor, cursor + entry.bytes);
    if (!slice.length) break;
    clock += entry.delay;
    // Bytes, not characters: slicing the decoded string would drift the moment
    // a box-drawing character appears, which is immediately.
    const text = pending + decoder.decode(slice, { stream: true });
    cursor += entry.bytes;
    pending = "";

    // A chunk can hold several repaints, or part of one.
    let from = 0;
    for (;;) {
      const end = text.indexOf(FRAME_END, from);
      if (end < 0) break;
      const upto = end + FRAME_END.length;
      const done = feed(grid, text.slice(from, upto), row, col, sgr);
      ({ row, col, sgr } = done);
      // A partial escape here would be a repaint split across the marker,
      // which cannot happen; carry it anyway rather than dropping bytes.
      pending = done.pending;
      shots.push({ at: clock, frame: snapshot(grid) });
      from = upto;
    }
    const rest = feed(grid, text.slice(from), row, col, sgr);
    ({ row, col, sgr } = rest);
    pending = rest.pending;
  }
  shots.push({ at: clock + FINAL_DWELL, frame: snapshot(grid) });
  return shots;
}

function feed(grid, text, row, col, sgr) {
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\x1b") {
      const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i));
      if (!m) {
        // No terminator yet: this is the front of a sequence whose rest is in
        // the next chunk. Anything else starting with ESC is not ours, and is
        // dropped rather than printed.
        if (/^\x1b\[?[0-9;?]*$/.test(text.slice(i))) return { row, col, sgr, pending: text.slice(i) };
        i += 1;
        continue;
      }
      {
        const [all, argsRaw, cmd] = m;
        const nums = argsRaw.split(";").filter((x) => x !== "").map(Number);
        if (cmd === "H") {
          row = Math.max(0, (nums[0] ?? 1) - 1);
          col = Math.max(0, (nums[1] ?? 1) - 1);
        } else if (cmd === "J" && argsRaw === "2") {
          for (const r of grid) for (let c = 0; c < COLS; c++) r[c] = blankCell();
        } else if (cmd === "K") {
          if (row < ROWS) for (let c = col; c < COLS; c++) grid[row][c] = blankCell();
        } else if (cmd === "m") {
          sgr = applySgr(sgr, nums.length ? nums : [0]);
        }
        i += all.length;
        continue;
      }
    }
    const ch = text[i];
    // Nothing unprintable ever reaches a cell: a stray control byte would make
    // the SVG invalid XML, which a browser refuses silently.
    if (ch < " " && ch !== "\n" && ch !== "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row++;
      col = 0;
    } else if (ch === "\r") {
      col = 0;
    } else {
      if (row < ROWS && col < COLS) grid[row][col] = { ch, fg: sgr.fg, bold: sgr.bold, dim: sgr.dim };
      col++;
    }
    i++;
  }
  return { row, col, sgr, pending: "" };
}

function applySgr(sgr, nums) {
  let next = { ...sgr };
  for (const n of nums) {
    if (n === 0) next = { fg: null, bold: false, dim: false };
    else if (n === 1) next.bold = true;
    else if (n === 2) next.dim = true;
    else if (n === 22) next = { ...next, bold: false, dim: false };
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) next.fg = n;
    else if (n === 39) next.fg = null;
  }
  return next;
}

/** Collapse a grid into styled runs per row, trimming trailing blanks. */
function snapshot(grid) {
  return grid.map((row) => {
    let end = COLS;
    while (end > 0 && row[end - 1].ch === " ") end--;
    const runs = [];
    for (let c = 0; c < end; c++) {
      const cell = row[c];
      const last = runs[runs.length - 1];
      if (last && last.fg === cell.fg && last.bold === cell.bold && last.dim === cell.dim) {
        last.text += cell.ch;
      } else {
        runs.push({ text: cell.ch, fg: cell.fg, bold: cell.bold, dim: cell.dim });
      }
    }
    return runs;
  });
}

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

const COLORS = {
  30: "#5c6370", 31: "#e88388", 32: "#a7cc8c", 33: "#dbab79", 34: "#71bef2",
  35: "#d290e4", 36: "#66c2cd", 37: "#c6c8d1", 90: "#6b7089", 91: "#e88388",
  92: "#a7cc8c", 93: "#dbab79", 94: "#71bef2", 95: "#d290e4", 96: "#66c2cd",
};
const FG = "#c6c8d1";
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

let bytes = readFileSync(rawPath);
// `script` writes its own header into the log; the timing offsets begin after
// it, so leaving it in would shift every chunk by its length.
const firstNewline = bytes.indexOf(0x0a);
if (firstNewline >= 0 && bytes.subarray(0, 14).toString("latin1") === "Script started") {
  bytes = bytes.subarray(firstNewline + 1);
}
// The session ends when the app hands the terminal back. Anything after that
// belongs to whatever wrapped the recording, not to the thing being recorded.
const ended = bytes.indexOf(Buffer.from("\x1b[?1049l", "latin1"));
if (ended >= 0) bytes = bytes.subarray(0, ended);
const timing = readFileSync(timingPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [delay, bytes] = l.trim().split(/\s+/);
    return { delay: Number(delay), bytes: Number(bytes) };
  })
  .filter((e) => Number.isFinite(e.delay) && Number.isFinite(e.bytes));

const shots = replay(bytes, timing);
// How long each repaint stayed up before the next one replaced it. A frame
// nobody had time to read is a keystroke, not a moment worth showing.
let frames = shots
  .map((s, i) => ({ ...s, held: (shots[i + 1]?.at ?? s.at) - s.at }))
  .filter((s) => s.held >= SETTLE)
  .map((s) => s.frame)
  .filter((f) => f.some((row) => row.length));
// Drop frames identical to the one before: nothing changed, nothing to show.
frames = frames.filter((f, i) => i === 0 || JSON.stringify(f) !== JSON.stringify(frames[i - 1]));
// Keep the last MAX_FRAMES: the end of a session is the part worth showing.
if (frames.length > MAX_FRAMES) frames = frames.slice(frames.length - MAX_FRAMES);
if (!frames.length) {
  console.error("nothing was captured — is the raw stream from a full-screen session?");
  process.exit(1);
}

/**
 * Advance width used only to size the canvas.
 *
 * Which monospace font actually renders this depends on the reader's machine,
 * and guessing too narrow clips the right-hand column. Guessing a little wide
 * leaves a sliver of background, which nobody notices.
 */
const CH = 7.75;
const LH = 17;
const PAD = 18;
const TOP = 40;
const W = Math.round(PAD * 2 + COLS * CH);
const H = TOP + PAD + ROWS * LH;

const dwells = frames.map((_, i) => (i === frames.length - 1 ? FINAL_DWELL : DWELL));
const total = dwells.reduce((a, b) => a + b, 0);

let at = 0;
const groups = frames.map((frame, i) => {
  const start = (at / total) * 100;
  at += dwells[i];
  const end = (at / total) * 100;
  const eps = 0.001;
  const kf =
    `@keyframes f${i}{0%,${Math.max(0, start - eps).toFixed(3)}%{opacity:0}` +
    `${start.toFixed(3)}%,${Math.max(0, end - eps).toFixed(3)}%{opacity:1}` +
    `${end.toFixed(3)}%,100%{opacity:0}}`;

  // Each frame carries its own background. If two are ever briefly visible at
  // once — a keyframe boundary, a browser rounding the timing — the later one
  // covers the earlier instead of the two interleaving into nonsense.
  const bg = `<rect y="${TOP}" width="${W}" height="${H - TOP}" fill="#1c1e26"/>`;
  const body = frame
    .map((runs, r) => {
      if (!runs.length) return "";
      const spans = runs
        .map((run, j) => {
          const style = [
            `fill:${run.fg ? COLORS[run.fg] ?? FG : FG}`,
            run.bold ? "font-weight:700" : "",
            run.dim ? "opacity:.6" : "",
          ]
            .filter(Boolean)
            .join(";");
          return `<tspan${j === 0 ? ` x="${PAD}"` : ""} style="${style}">${esc(run.text)}</tspan>`;
        })
        .join("");
      return `<text y="${TOP + PAD + r * LH}" xml:space="preserve">${spans}</text>`;
    })
    .filter(Boolean)
    .join("");
  return { kf, g: `<g class="f" style="animation-name:f${i}">${bg}${body}</g>` };
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(LABEL)}">
<style>
  text{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:12.5px;white-space:pre}
  .f{opacity:0;animation-duration:${total.toFixed(2)}s;animation-iteration-count:infinite;animation-timing-function:steps(1,end)}
  ${groups.map((g) => g.kf).join("")}
  @media (prefers-reduced-motion:reduce){.f{animation:none}.f:last-of-type{opacity:1}}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#1c1e26"/>
<rect width="${W}" height="${TOP}" rx="10" fill="#22242e"/>
<rect y="${TOP - 10}" width="${W}" height="10" fill="#22242e"/>
<circle cx="20" cy="20" r="5.5" fill="#e88388"/><circle cx="38" cy="20" r="5.5" fill="#dbab79"/><circle cx="56" cy="20" r="5.5" fill="#a7cc8c"/>
<text x="${W / 2}" y="24" text-anchor="middle" style="font-size:11.5px;fill:#6b7089">mpx share — amber-ridge-04</text>
${groups.map((g) => g.g).join("\n")}
</svg>
`;

// An SVG a browser refuses is worse than no SVG: it fails silently, as a
// broken image in a README that nobody notices for weeks.
const control = [...svg].find((c) => c < " " && c !== "\n" && c !== "\t");
if (control) {
  console.error(`refusing to write: a control byte (0x${control.codePointAt(0).toString(16)}) reached the output`);
  process.exit(1);
}

writeFileSync(outPath, svg);
console.log(`${outPath}  ${frames.length} frames, ${W}x${H}, ${total.toFixed(1)}s loop, ${(svg.length / 1024).toFixed(0)}KB`);
