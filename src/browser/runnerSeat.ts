import type { ServerMessage } from "../protocol.js";
import type { WebConnection } from "./webConnection.js";
import { finishBrowserTurn } from "./webRunner.js";
import { INITIAL_TURN_STATE, nextDelta, stepTurn, type TurnState } from "./streamTurn.js";

/**
 * The seam a real content-script bridge implements. `RunnerSeat` never
 * touches the DOM itself — `streamTurn.ts` already proved the delta/done
 * logic without one, and this keeps that proof intact by only depending on
 * this narrow interface. `test/runnerSeat.test.ts` uses a scripted fake, the
 * same way `test/failover.test.ts` drives a stub CLI binary rather than a
 * real one.
 */
export interface SiteDriver {
  /** Type the prompt into the page and trigger send. */
  send(prompt: string): Promise<void>;
  /**
   * Subscribe to the page's response as it renders. Called once per turn;
   * returns an unsubscribe function. `generating` reflects the site's own
   * "stop" control, the same signal `stepTurn` uses to debounce completion.
   */
  watch(onObservation: (text: string, generating: boolean) => void): () => void;
  /** The current "you're out of capacity" banner text, or null if none is showing. */
  limitBanner(): string | null;
  /** Click the site's own stop/cancel control. */
  cancel(): Promise<void>;
}

/**
 * Offers a chat site's tab — and whatever subscription is signed into it —
 * to the room, the browser-extension twin of `client/runner.ts`'s
 * `LocalRunner`. Same `offer`/`withdraw`/`handle` shape, so wiring it up
 * looks the same as wiring up a CLI seat; the difference is entirely inside
 * `run()`, which drives a `SiteDriver` instead of spawning a process.
 */
export class RunnerSeat {
  private current: { turnId: string } | null = null;

  constructor(
    private conn: WebConnection,
    private backendLabel: string,
    private site: SiteDriver,
    private onNotice: (text: string) => void,
    private now: () => number = Date.now,
  ) {}

  offer(): void {
    void this.conn.send({ t: "runner", backend: this.backendLabel, cwd: this.backendLabel });
  }

  withdraw(): void {
    void this.conn.send({ t: "runnerGone" });
  }

  /** Route the two messages a runner cares about; everything else belongs to whatever else reads this connection. */
  handle(msg: ServerMessage): boolean {
    if (msg.t === "runTurn") {
      void this.run(msg.turnId, msg.prompt);
      return true;
    }
    if (msg.t === "runCancel") {
      if (this.current?.turnId === msg.turnId) void this.site.cancel();
      return true;
    }
    return false;
  }

  private async run(turnId: string, prompt: string): Promise<void> {
    if (this.current) {
      await this.conn.send({ t: "runEnd", turnId, stopReason: "error", error: "this runner is already busy" });
      return;
    }
    this.current = { turnId };
    this.onNotice(`running this turn on your ${this.backendLabel} session`);

    let state: TurnState = INITIAL_TURN_STATE;
    let lastAt = this.now();
    let settled = false;

    const settle = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      unsubscribe();
      const banner = this.site.limitBanner();
      const result = finishBrowserTurn(banner);
      this.current = null;
      await this.conn.send({
        t: "runEnd",
        turnId,
        stopReason: result.stopReason,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(result.limited ? { limited: true } : {}),
        ...(result.until !== undefined ? { until: result.until } : {}),
      });
      if (result.limited) {
        this.onNotice("your account is out of capacity — the room will carry on elsewhere");
      }
    };

    const unsubscribe = this.site.watch((text, generating) => {
      if (settled) return;
      const at = this.now();
      const elapsedMs = at - lastAt;
      lastAt = at;

      const step = nextDelta(state.text, text);
      if (step.delta) void this.conn.send({ t: "runOut", turnId, kind: "text", text: step.delta });

      const turn = stepTurn(state, { text, generating, elapsedMs });
      if (turn.done) {
        void settle();
      } else {
        state = turn.state;
      }
    });

    try {
      await this.site.send(prompt);
    } catch (err) {
      if (!settled) {
        settled = true;
        unsubscribe();
        this.current = null;
        await this.conn.send({ t: "runEnd", turnId, stopReason: "error", error: (err as Error)?.message ?? String(err) });
      }
    }
  }
}
