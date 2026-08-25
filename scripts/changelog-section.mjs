#!/usr/bin/env node
/**
 * Print one version's section of CHANGELOG.md.
 *
 * Release notes should be the notes we already wrote, not a second description
 * of the same work that can drift away from the first.
 *
 *   node scripts/changelog-section.mjs 0.10.0
 */
import { readFileSync } from "node:fs";

const want = (process.argv[2] ?? "").replace(/^v/, "");
if (!want) {
  console.error("usage: changelog-section.mjs <version>");
  process.exit(2);
}

const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const heading = (l) => /^##\s+/.test(l);
const start = lines.findIndex((l) => heading(l) && l.replace(/^##\s+/, "").trim().replace(/^v/, "") === want);
if (start < 0) {
  console.error(`no section for ${want} in CHANGELOG.md`);
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (heading(lines[i])) {
    end = i;
    break;
  }
}
console.log(lines.slice(start + 1, end).join("\n").trim());
