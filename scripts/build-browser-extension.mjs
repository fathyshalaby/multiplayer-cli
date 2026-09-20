#!/usr/bin/env node
/**
 * Bundle the Chrome extension into the three files its manifest names.
 *
 * Same shape as scripts/build-extension.mjs for the VS Code extension: type
 * check first (esbuild strips types without checking them), then let esbuild
 * resolve src/browser/*.ts straight from the root package so the extension
 * runs exactly the same WebConnection/RunnerSeat code
 * test/runnerSeat.test.ts proves against a real room.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "browser-extension", "src");
const dist = join(root, "browser-extension", "dist");

execFileSync("npx", ["tsc", "-p", join(root, "browser-extension/tsconfig.json")], { stdio: "inherit" });

mkdirSync(dist, { recursive: true });

const shared = { bundle: true, platform: "browser", target: "chrome110", outdir: dist, sourcemap: true, minify: false, logLevel: "info" };

// The background service worker (declared `"type": "module"` in the
// manifest) and options.html's own `<script type="module">` can both be ES
// modules. A declarative `content_scripts` entry cannot — Chrome injects it
// as a classic script — so it bundles as an IIFE instead.
await build({ ...shared, entryPoints: { background: join(src, "background.ts") }, format: "esm" });
await build({ ...shared, entryPoints: { options: join(src, "options.ts") }, format: "esm" });
await build({ ...shared, entryPoints: { content: join(src, "content", "index.ts") }, format: "iife" });

copyFileSync(join(root, "browser-extension", "manifest.json"), join(dist, "manifest.json"));
copyFileSync(join(src, "options.html"), join(dist, "options.html"));
