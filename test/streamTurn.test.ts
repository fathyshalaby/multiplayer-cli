import test from "node:test";
import assert from "node:assert/strict";
import { nextDelta, stepTurn, INITIAL_TURN_STATE, type TurnState } from "../src/browser/streamTurn.js";

/* ---- nextDelta ----------------------------------------------------- */

test("identical snapshots produce no delta", () => {
  const step = nextDelta("Hello", "Hello");
  assert.equal(step.delta, "");
  assert.equal(step.rewrote, false);
});

test("an appended snapshot yields just the new suffix", () => {
  const step = nextDelta("Hello", "Hello, world");
  assert.equal(step.delta, ", world");
  assert.equal(step.rewrote, false);
});

test("the first observation against empty text streams all of it", () => {
  const step = nextDelta("", "Hi there");
  assert.equal(step.delta, "Hi there");
  assert.equal(step.rewrote, false);
});

test("a site rewriting earlier text is flagged, not silently diffed", () => {
  // A markdown reflow or a corrected reply does not start with the old text.
  const step = nextDelta("Hello, wrold", "Hello, world");
  assert.equal(step.delta, "Hello, world");
  assert.equal(step.rewrote, true);
});

test("text going shorter than before is a rewrite, not a negative delta", () => {
  const step = nextDelta("Hello, world", "Hello");
  assert.equal(step.delta, "Hello");
  assert.equal(step.rewrote, true);
});

/* ---- stepTurn -------------------------------------------------------- */

test("a turn that is still generating never counts as done", () => {
  let state: TurnState = INITIAL_TURN_STATE;
  for (let i = 0; i < 5; i++) {
    const step = stepTurn(state, { text: "still typing", generating: true, elapsedMs: 5000 });
    assert.equal(step.done, false);
    state = (step as { done: false; state: TurnState }).state;
  }
});

test("growth resets the quiet clock even after it had built up", () => {
  let state: TurnState = { text: "Hello", quietMs: 1000 };
  const step = stepTurn(state, { text: "Hello, more", generating: true, elapsedMs: 500 });
  assert.equal(step.done, false);
  assert.equal((step as { done: false; state: TurnState }).state.quietMs, 0);
});

test("quiet time must cross the threshold, not just reach one sample", () => {
  const state: TurnState = { text: "Done.", quietMs: 0 };
  const first = stepTurn(state, { text: "Done.", generating: false, elapsedMs: 300 });
  assert.equal(first.done, false);
  assert.equal((first as { done: false; state: TurnState }).state.quietMs, 300);
});

test("a turn is done once text is unchanged, not generating, past the threshold", () => {
  let state: TurnState = INITIAL_TURN_STATE;
  const chunks = ["Hel", "Hello", "Hello there"];
  for (const text of chunks) {
    const step = stepTurn(state, { text, generating: true, elapsedMs: 200 });
    assert.equal(step.done, false);
    state = (step as { done: false; state: TurnState }).state;
  }
  // The stop control disappears but the DOM needs a few quiet ticks before
  // this counts as finished rather than a gap between tokens.
  let step = stepTurn(state, { text: "Hello there", generating: false, elapsedMs: 400 });
  assert.equal(step.done, false);
  state = (step as { done: false; state: TurnState }).state;
  step = stepTurn(state, { text: "Hello there", generating: false, elapsedMs: 400 });
  assert.equal(step.done, false);
  state = (step as { done: false; state: TurnState }).state;
  step = stepTurn(state, { text: "Hello there", generating: false, elapsedMs: 400 });
  assert.equal(step.done, true);
  assert.equal((step as { done: true; text: string }).text, "Hello there");
});

test("a custom quiet threshold is honored", () => {
  const state: TurnState = { text: "x", quietMs: 0 };
  const step = stepTurn(state, { text: "x", generating: false, elapsedMs: 50 }, 40);
  assert.equal(step.done, true);
});
