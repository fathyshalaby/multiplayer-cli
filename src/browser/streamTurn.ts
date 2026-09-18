/**
 * Turns raw text snapshots of a chat site's DOM into the same streaming
 * shape `ProfileSink` gives a CLI backend (`process.ts`), and decides when a
 * turn is over.
 *
 * This is the one genuinely novel risk in driving ChatGPT/Claude.ai/etc. from
 * a browser extension instead of a CLI: there is no exit code and no "done"
 * event, only a DOM that keeps changing until it doesn't. Kept pure — no
 * `MutationObserver`, no timers, no site-specific selectors — so that risk is
 * a unit test instead of something only provable against a live site.
 */

export interface DeltaStep {
  /** Text to stream to the room for this observation. */
  delta: string;
  /**
   * True if `current` was not a growth of `previous` — the site re-rendered
   * earlier text (a markdown reflow, a correction) instead of only
   * appending. The whole current text is still emitted as the delta so the
   * room sees *something*, but a caller may want to say so rather than let
   * it look like an ordinary append.
   */
  rewrote: boolean;
}

export function nextDelta(previous: string, current: string): DeltaStep {
  if (current === previous) return { delta: "", rewrote: false };
  if (current.startsWith(previous)) return { delta: current.slice(previous.length), rewrote: false };
  return { delta: current, rewrote: true };
}

export interface TurnObservation {
  /** The response container's full text at this instant. */
  text: string;
  /** Whether the site's own "stop generating" control is visible right now. */
  generating: boolean;
  /** Time since the previous observation. Passed in, never read from a clock. */
  elapsedMs: number;
}

export interface TurnState {
  text: string;
  /** How long `text` has sat unchanged with generation not visibly running. */
  quietMs: number;
}

export const INITIAL_TURN_STATE: TurnState = { text: "", quietMs: 0 };

export type TurnStep = { done: false; state: TurnState } | { done: true; text: string };

/**
 * How long text must sit unchanged, with the site's own "stop" control gone,
 * before a turn counts as finished. Some sites blink the stop control off for
 * a beat mid-stream, so "text stopped growing" alone is not enough — this is
 * the debounce that keeps a mid-token gap from being mistaken for the end.
 */
const QUIET_THRESHOLD_MS = 1200;

export function stepTurn(state: TurnState, obs: TurnObservation, quietThresholdMs = QUIET_THRESHOLD_MS): TurnStep {
  const grew = obs.text !== state.text;
  const quietMs = grew ? 0 : state.quietMs + obs.elapsedMs;
  if (!grew && !obs.generating && quietMs >= quietThresholdMs) {
    return { done: true, text: obs.text };
  }
  return { done: false, state: { text: obs.text, quietMs } };
}
