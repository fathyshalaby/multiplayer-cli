import test from "node:test";
import assert from "node:assert/strict";
import { finishBrowserTurn } from "../src/browser/webRunner.js";

/**
 * Proves a browser-driven runner's turn result plugs into the room's
 * existing capacity-handoff mechanism (`RoutedBackend` in
 * `src/server/runners.ts`) without any change to it — the room already only
 * cares whether `TurnResult.limited` is set, regardless of which kind of
 * runner produced it.
 *
 * The banner strings below are representative phrasing, not text confirmed
 * against a live ChatGPT/Claude.ai session — that confirmation is real work
 * for whoever builds the actual site adapter, not something provable here.
 */

test("an ordinary finished turn is not mistaken for a spent account", () => {
  const result = finishBrowserTurn(null);
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.limited, undefined);
});

test("a usage-limit banner is recognised and carries a reset time", () => {
  const result = finishBrowserTurn("You've reached your usage limit for messages. Try again in 45 minutes.");
  assert.equal(result.stopReason, "error");
  assert.equal(result.limited, true);
  assert.ok(result.until && result.until > Date.now());
});

test("a limit banner with a wall-clock reset resolves it the same way agent/limits.ts does for CLIs", () => {
  const result = finishBrowserTurn("Your usage limit has been reached. It will reset at 3pm.");
  assert.equal(result.limited, true);
  assert.ok(result.until);
  assert.equal(new Date(result.until!).getHours(), 15);
});

test("plausible banner phrasing that agent/limits.ts's narrow patterns do not (yet) cover is a real gap, not a bug in this module", () => {
  // This is the exact risk agent/limits.ts's own header comment names: "a
  // false negative strands the room on an account that cannot answer." A
  // site adapter must confirm its site's actual wording and, if needed,
  // extend LIMIT_PATTERNS deliberately — this test documents that finishBrowserTurn
  // does not paper over it by guessing.
  const result = finishBrowserTurn("Your message limit has been reached. It will reset at 3pm.");
  assert.equal(result.limited, undefined, "not recognised yet — confirm real site wording before adding a pattern");
});

test("an unrecognised error banner stays a plain failure, not a false handoff", () => {
  // The narrowness is the point (agent/limits.ts's own header comment): a
  // site error mpx has never seen should not silently look like capacity.
  const result = finishBrowserTurn("Something went wrong. Please refresh the page.");
  assert.equal(result.stopReason, "error");
  assert.equal(result.limited, undefined);
});
