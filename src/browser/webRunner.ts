import { classify } from "../agent/limits.js";
import type { TurnResult } from "../agent/types.js";

/**
 * Turns what a chat site's DOM showed at the end of a turn into the exact
 * `TurnResult` shape `LocalRunner`/`RoutedBackend` already route on
 * (`src/client/runner.ts:149`, `src/server/runners.ts`) — including
 * `limited`/`until`, the fields that make a room move to the next runner's
 * session automatically once one account is spent.
 *
 * This is the whole answer to "share the subscriptions, and when one
 * person's session runs out, move to the next": `agent/limits.ts` already
 * recognises "out of capacity" from plain text across every CLI backend, and
 * it has zero imports — nothing Node-specific — so it works unmodified from
 * a browser extension too. A browser-driven runner only has to notice its
 * site's own "you're out of capacity" banner and hand its text to
 * `classify()`, the same call every other runner already makes. No server or
 * protocol change is needed for the handoff itself.
 *
 * What *is* still open: the exact banner text each site uses has to be
 * confirmed against the live UI when the real adapter for that site is
 * built — `agent/limits.ts`'s patterns were written against real CLI output;
 * a site adapter must do the same for its site rather than assume generic
 * phrases like "usage limit" happen to appear verbatim.
 */
export function finishBrowserTurn(limitBannerText: string | null): TurnResult {
  if (limitBannerText) return classify({ stopReason: "error", error: limitBannerText });
  return { stopReason: "end_turn" };
}
