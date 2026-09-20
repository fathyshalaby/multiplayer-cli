import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Proves `DomSiteDriver` (`browser-extension/src/content/domSiteDriver.ts`)
 * against a real page in a real Chromium — the one part of this whole
 * project that genuinely cannot be proven any other way. Not against a real
 * chat site: there is no account to drive here and no way to make that
 * reproducible in CI, and this repo's own convention for exactly this
 * situation is a stub that behaves the way the real thing documents itself
 * to (`test/backends.test.ts` against stub CLI binaries). A chat site
 * documents nothing, so the fixture instead behaves the way these sites'
 * front ends actually work: a controlled `contenteditable` box that reacts
 * only to a real `input` event, never to an outside script just writing
 * text into it.
 *
 * Skipped cleanly when neither Playwright nor a Chromium build is available,
 * same as `test/browser.test.ts`.
 */
const CHROME_CANDIDATES = [
  process.env.MPX_CHROME,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
].filter(Boolean) as string[];

let shared: any = null;
let attempted = false;

async function browser() {
  if (attempted) return shared;
  attempted = true;
  let chromium: any;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  const explicit = CHROME_CANDIDATES.find((p) => existsSync(p));
  try {
    shared = await chromium.launch(explicit ? { executablePath: explicit } : {});
  } catch {
    shared = null;
  }
  return shared;
}

after(async () => {
  await shared?.close().catch(() => {});
  shared = null;
});

// This file runs compiled, from dist/test/ — tsc does not copy non-.ts
// assets (the fixture HTML, the extension's own .ts source), so both paths
// below are resolved against the repository root, not this compiled file's
// own directory.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturePath = join(repoRoot, "test", "fixtures", "fake-chat-site.html");
const driverEntry = join(repoRoot, "browser-extension", "src", "content", "domSiteDriver.ts");

async function bundledDriver(): Promise<string> {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [driverEntry],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "MpxContent",
    platform: "browser",
    target: "chrome110",
  });
  return result.outputFiles[0]!.text;
}

const FIXTURE_CONFIG = {
  name: "fake-site",
  composeSelector: "#prompt-textarea",
  sendSelector: "#send-button",
  stopSelector: "#stop-button:not([hidden])",
  responseSelector: "[data-message-author-role='assistant']:last-of-type",
  limitBannerSelector: "#limit-banner:not([hidden])",
};

test("DomSiteDriver drives a real page's compose box and observes its real DOM mutations", async (t) => {
  const b = await browser();
  if (!b) return t.skip("no Playwright/Chromium in this environment");

  const page = await b.newPage();
  t.after(() => page.close());
  await page.goto(`file://${fixturePath}`);
  await page.addScriptTag({ content: await bundledDriver() });

  // This callback runs inside the page, a different global-type world than
  // the Node test file it is textually embedded in — `window`/`document`
  // are not declared here (this project's tsconfig carries no DOM lib, on
  // purpose: see browser-extension/tsconfig.json for where that lib lives),
  // so it goes through `globalThis as any` rather than pull DOM types into
  // every Node source file in this repo for the sake of one inline callback.
  const result = await page.evaluate(async (config: unknown) => {
    const w = globalThis as any;
    w.__setScript([
      { text: "Hel", delayMs: 5, limited: false },
      { text: "Hello there", delayMs: 5, limited: false },
    ]);
    const driver = new w.MpxContent.DomSiteDriver(config);
    const observations: { text: string; generating: boolean }[] = [];
    const unsubscribe = driver.watch((text: string, generating: boolean) => observations.push({ text, generating }));
    await driver.send("hello from the driver");
    // Wait for the fixture's scripted reply to finish (stop button hides).
    await new Promise((resolve) => {
      const iv = w.setInterval(() => {
        const stopHidden = w.document.getElementById("stop-button").hidden;
        if (stopHidden) {
          w.clearInterval(iv);
          resolve(undefined);
        }
      }, 5);
    });
    unsubscribe();
    return { observations, lastPrompt: w.__lastPrompt };
  }, FIXTURE_CONFIG);

  const observations = result.observations as { text: string; generating: boolean }[];
  assert.equal(result.lastPrompt, "hello from the driver", "the fixture's own input listener saw the driver's text, not just a direct write");
  const texts = observations.map((o) => o.text);
  assert.ok(texts.includes("Hello there"), `expected the final streamed text among observations, got ${JSON.stringify(texts)}`);
  assert.ok(
    observations.some((o) => o.generating === true),
    "the driver must see the stop control while the fixture is 'generating'",
  );
  assert.equal(observations.at(-1)!.generating, false, "generating must clear once the fixture hides its stop control");
});

test("DomSiteDriver reports a limit banner the fixture shows instead of a reply", async (t) => {
  const b = await browser();
  if (!b) return t.skip("no Playwright/Chromium in this environment");

  const page = await b.newPage();
  t.after(() => page.close());
  await page.goto(`file://${fixturePath}`);
  await page.addScriptTag({ content: await bundledDriver() });

  const banner = await page.evaluate(async (config: unknown) => {
    const w = globalThis as any;
    w.__setScript([{ text: "You have reached your usage limit.", delayMs: 5, limited: true }]);
    const driver = new w.MpxContent.DomSiteDriver(config);
    await driver.send("go");
    await new Promise((resolve) => setTimeout(resolve, 50));
    return driver.limitBanner();
  }, FIXTURE_CONFIG);

  assert.equal(banner, "You have reached your usage limit.");
});

test("DomSiteDriver.cancel clicks the fixture's real stop control", async (t) => {
  const b = await browser();
  if (!b) return t.skip("no Playwright/Chromium in this environment");

  const page = await b.newPage();
  t.after(() => page.close());
  await page.goto(`file://${fixturePath}`);
  await page.addScriptTag({ content: await bundledDriver() });

  const cancelled = await page.evaluate(async (config: unknown) => {
    const w = globalThis as any;
    w.__setScript([
      { text: "still going", delayMs: 5000, limited: false },
    ]);
    const driver = new w.MpxContent.DomSiteDriver(config);
    await driver.send("go");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await driver.cancel();
    return w.__cancelled;
  }, FIXTURE_CONFIG);

  assert.equal(cancelled, true);
});
