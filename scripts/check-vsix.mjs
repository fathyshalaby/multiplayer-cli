#!/usr/bin/env node
/**
 * Check what the packaged extension actually contains.
 *
 * The `vscode` CI job runs the extension from source, which proves it
 * activates but says nothing about what gets published. A `.vscodeignore`
 * mistake can therefore ship a package that is missing something it needs at
 * runtime, or one bloated with source maps and tests — and neither shows up
 * until somebody installs it.
 *
 * Usage: check-vsix.mjs <path.vsix>
 */
import { execFileSync } from "node:child_process";

const vsix = process.argv[2];
if (!vsix) {
  console.error("usage: check-vsix.mjs <path.vsix>");
  process.exit(2);
}

const listing = execFileSync("unzip", ["-Z1", vsix], { encoding: "utf8" })
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

/** Without these the extension does not run. */
const required = [
  "extension/package.json",
  "extension/dist/extension.js",
  // The browser seat is served from inside the extension host.
  "extension/dist/session.html",
];

/** Shipping these is waste at best and confusing at worst. */
const forbidden = [
  { pattern: /^extension\/test\//, why: "tests belong in CI, not in a download" },
  { pattern: /^extension\/src\//, why: "TypeScript source; the bundle is what runs" },
  { pattern: /\.map$/, why: "source map pointing at sources that are not shipped" },
  { pattern: /^extension\/tsconfig\.json$/, why: "build config" },
];

let bad = 0;
for (const need of required) {
  if (!listing.includes(need)) {
    console.error(`missing: ${need}`);
    bad++;
  }
}
for (const entry of listing) {
  for (const rule of forbidden) {
    if (rule.pattern.test(entry)) {
      console.error(`should not be published: ${entry} — ${rule.why}`);
      bad++;
    }
  }
}

if (bad) {
  console.error(`\n${bad} problem${bad === 1 ? "" : "s"} with ${vsix}`);
  process.exit(1);
}
console.log(`${vsix}: ${listing.length} files, nothing missing and nothing extra`);
