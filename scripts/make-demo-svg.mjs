#!/usr/bin/env node
/**
 * Turn a real captured session into an animated SVG for the README.
 *
 * Recording a genuine run and replaying it beats hand-drawing a mockup: the
 * demo cannot drift from what the tool actually prints, because it *is* what
 * the tool printed.
 *
 * Usage: node scripts/make-demo-svg.mjs <capture.txt> <out.svg>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: make-demo-svg.mjs <capture.txt> <out.svg>");
  process.exit(1);
}

/* The palette mpx actually uses, mapped to something legible on a dark card. */
const COLORS = {
  30: "#5c6370", 31: "#e88388", 32: "#a7cc8c", 33: "#dbab79", 34: "#71bef2",
  35: "#d290e4", 36: "#66c2cd", 37: "#c6c8d1", 90: "#6b7089", 91: "#e88388",
  92: "#a7cc8c", 93: "#dbab79", 94: "#71bef2", 95: "#d290e4", 96: "#66c2cd",
};
const FG = "#c6c8d1";

/** Split one line into styled runs by walking its SGR escapes. */
function parseLine(line) {
  const runs = [];
  let fg = null, bold = false, dim = false, underline = false, text = "";
  const flush = () => {
    if (text) runs.push({ text, fg, bold, dim, underline });
    text = "";
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0, m;
  while ((m = re.exec(line))) {
    text += line.slice(last, m.index);
    last = re.lastIndex;
    flush();
    for (const raw of m[1].split(";")) {
      const code = Number(raw || "0");
      if (code === 0) { fg = null; bold = dim = underline = false; }
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 4) underline = true;
      else if (code === 22) { bold = false; dim = false; }
      else if (code === 24) underline = false;
      else if (code === 39) fg = null;
      else if (COLORS[code]) fg = COLORS[code];
    }
  }
  text += line.slice(last);
  flush();
  return runs;
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

const raw = readFileSync(inPath, "utf8").replace(/\r/g, "").split("\n");
// Trim leading and trailing blank lines without touching the shape in between.
while (raw.length && !raw[0].trim()) raw.shift();
while (raw.length && !raw[raw.length - 1].trim()) raw.pop();
const lines = raw.map(parseLine);

const CH = 7.62;          // advance width of the font at 13px
const LH = 20;            // line height
const PAD = 22;
const TOP = 46;           // room for the window chrome
const cols = Math.max(...lines.map((r) => r.reduce((n, x) => n + x.text.length, 0)), 40);
const W = Math.round(PAD * 2 + cols * CH);
const H = TOP + PAD + lines.length * LH;

/* Reveal each line in turn, hold the finished frame, then loop. */
const STEP = 0.26;        // seconds between lines
const HOLD = 4.5;         // seconds the completed session stays up
const total = lines.length * STEP + HOLD;
const pct = (t) => ((t / total) * 100).toFixed(3);

const keyframes = lines
  .map((_, i) => {
    const at = pct(i * STEP);
    const on = pct(i * STEP + 0.001);
    return `@keyframes r${i}{0%,${at}%{opacity:0}${on}%,100%{opacity:1}}`;
  })
  .join("");

const body = lines
  .map((runs, i) => {
    // Only the line's first run is positioned; the rest flow after it. Setting
    // x per run assumes every glyph advances one cell, which the ✓ ✗ · ▸ in
    // this output do not — that drift is what makes text collide.
    const spans = runs
      .map((r, j) => {
        const style = [
          `fill:${r.fg ?? FG}`,
          r.bold ? "font-weight:700" : "",
          r.dim ? "opacity:.62" : "",
          r.underline ? "text-decoration:underline" : "",
        ].filter(Boolean).join(";");
        return `<tspan${j === 0 ? ` x="${PAD}"` : ""} style="${style}">${esc(r.text)}</tspan>`;
      })
      .join("");
    const y = TOP + PAD + i * LH;
    return `<text y="${y}" class="l" xml:space="preserve" style="animation-name:r${i}">${spans}</text>`;
  })
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="A recorded multiplayer-cli session: alice proposes a change, bob vetoes it with a reason, and the room talks it over.">
<style>
  .l{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"DejaVu Sans Mono",monospace;font-size:13px;white-space:pre;opacity:0;
     animation-duration:${total.toFixed(2)}s;animation-iteration-count:infinite;animation-timing-function:steps(1,end)}
  ${keyframes}
  @media (prefers-reduced-motion:reduce){.l{opacity:1;animation:none}}
</style>
<rect width="${W}" height="${H}" rx="10" fill="#1c1e26"/>
<rect width="${W}" height="${TOP}" rx="10" fill="#22242e"/>
<rect y="${TOP - 10}" width="${W}" height="10" fill="#22242e"/>
<circle cx="21" cy="23" r="6" fill="#e88388"/><circle cx="41" cy="23" r="6" fill="#dbab79"/><circle cx="61" cy="23" r="6" fill="#a7cc8c"/>
<text x="${W / 2}" y="27" text-anchor="middle" style="font-family:ui-monospace,monospace;font-size:12px;fill:#6b7089">mpx join — amber-ridge-04</text>
${body}
</svg>
`;

writeFileSync(outPath, svg);
console.log(`${outPath}  ${lines.length} lines, ${W}x${H}, ${total.toFixed(1)}s loop`);
