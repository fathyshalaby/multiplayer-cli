#!/usr/bin/env node
/**
 * Bundle the extension into a single file.
 *
 * The extension imports the room's client, protocol and crypto straight from
 * src/, so a seat in the editor runs exactly the same code as a seat in a
 * terminal. esbuild resolves that across the two packages; `vscode` stays
 * external because the editor provides it at runtime.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// esbuild strips types without checking them, so check them first.
execFileSync("npx", ["tsc", "-p", join(root, "extension/tsconfig.json")], { stdio: "inherit" });

await build({
  entryPoints: [join(root, "extension/src/extension.ts")],
  outfile: join(root, "extension/dist/extension.js"),
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  // `vscode` is provided by the editor. The Anthropic SDK is optional and
  // large — an editor seat hosts on a coding CLI, so bundling 12MB for the one
  // API-key backend would be two thirds of this file for nothing.
  external: ["vscode", "@anthropic-ai/sdk"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
});

// The browser seat is read from disk at runtime, so it has to travel with the
// bundle — a room hosted from the editor still serves an invite page.
mkdirSync(join(root, "extension/dist"), { recursive: true });
copyFileSync(join(root, "src/client/web/session.html"), join(root, "extension/dist/session.html"));
