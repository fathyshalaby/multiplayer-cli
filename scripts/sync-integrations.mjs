#!/usr/bin/env node
/**
 * Keep the editor-agent integrations in step with the skill and the manifest.
 *
 * The same number and the same prose kept ending up in several files and then
 * disagreeing: `mpx --version` lied for two releases, the extension offered
 * seven of eleven backends, and the skill named five. Every one of those was a
 * copy nobody remembered to update.
 *
 * So the skill is the source and Gemini's context file is generated from it,
 * and every version is taken from package.json. `--check` verifies rather than
 * writes, which is what CI runs: a stale copy fails the build instead of
 * shipping.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const skill = readFileSync(join(root, "skills/multiplayer/SKILL.md"), "utf8");

/** The skill without its YAML frontmatter, which is Claude Code's own. */
function body(md) {
  const m = /^---\n[\s\S]*?\n---\n/.exec(md);
  return m ? md.slice(m[0].length).trimStart() : md.trimStart();
}

const GENERATED = [
  "<!--",
  "  Generated from skills/multiplayer/SKILL.md by scripts/sync-integrations.mjs.",
  "  Edit the skill, then run `npm run sync`.",
  "-->",
  "",
].join("\n");

/** Files whose whole content is derived. */
const derived = [["gemini-extension/GEMINI.md", GENERATED + body(skill)]];

/** Files where only a version field is derived. */
const versioned = [
  ["gemini-extension/gemini-extension.json", version],
  [".claude-plugin/plugin.json", version],
  ["extension/package.json", version],
];

const stale = [];

for (const [rel, want] of derived) {
  const path = join(root, rel);
  const have = safeRead(path);
  if (have === want) continue;
  if (check) stale.push(rel);
  else writeFileSync(path, want);
}

for (const [rel, want] of versioned) {
  const path = join(root, rel);
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (json.version === want) continue;
  if (check) stale.push(`${rel} (version ${json.version}, expected ${want})`);
  else {
    json.version = want;
    // Two-space indent and a trailing newline, to match what is checked in.
    writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  }
}

if (!stale.length) {
  console.log(check ? "integrations are in step" : "integrations synced");
  process.exit(0);
}

console.error("out of step with the skill or the version:");
for (const s of stale) console.error(`  ${s}`);
console.error("\nrun `npm run sync`");
process.exit(1);

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
