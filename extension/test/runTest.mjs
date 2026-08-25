/**
 * Download a real VS Code and run the integration test inside it.
 *
 * Needs a display: CI wraps this in xvfb-run. The download host is reachable
 * from GitHub Actions but not from every sandbox, which is why this is a CI
 * job rather than part of `npm test`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = resolve(here, "..");
const extensionTestsPath = resolve(here, "integration", "index.cjs");

try {
  const code = await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    // A clean profile, and no other extension's activation getting in the way
    // of the one thing being measured.
    launchArgs: ["--disable-extensions", "--disable-gpu", "--no-sandbox"],
  });
  process.exit(code);
} catch (err) {
  console.error("the extension did not run in VS Code:", err);
  process.exit(1);
}
