import type { RunnerInfo } from "../protocol.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../agent/types.js";
import { classify } from "../agent/limits.js";

export interface RemoteDispatch {
  /** Ask a seat to run this turn, and stream its output back through `events`. */
  start(runnerId: string, turnId: string, prompt: string): void;
  cancel(runnerId: string, turnId: string): void;
}

interface Runner extends RunnerInfo {
  /** The host's own backend, for the local entry only. */
  backendRef?: AgentBackend;
}

export interface RoutedOptions {
  dispatch: RemoteDispatch;
  /** Is this a backend whose tool calls the room would otherwise vote on? */
  gatesTools?(backend: string): boolean;
  /** Does this room's policy actually put tool calls to a vote right now? */
  toolsAreGated?(): boolean;
  /** Called whenever the roster or the active runner changes. */
  onChange(): void;
  onNotice(text: string): void;
  now?: () => number;
  /** Cap on how much history a new runner is handed. */
  recapChars?: number;
}

interface Pending {
  turnId: string;
  runnerId: string;
  events: AgentEvents;
  resolve(r: TurnResult): void;
  usage: Record<string, number>;
}

/**
 * Runs the room's turns on whoever's subscription is available.
 *
 * The room stays on one runner for as long as it can, because staying put is
 * what keeps a session coherent — the underlying tool resumes its own thread
 * and keeps its own cache. A handoff happens only when an account reports it is
 * out of capacity, and then the room carries the conversation across itself, so
 * "usage limit reached, resets at 3pm" costs a paragraph of recap instead of
 * the afternoon.
 *
 * Implements AgentBackend, so the room does not know or care that a turn ran on
 * someone else's laptop.
 */
export class RoutedBackend implements AgentBackend {
  readonly name = "routed";
  private runners = new Map<string, Runner>();
  private activeId: string | null = null;
  private opts: RoutedOptions;
  private pending: Pending | null = null;
  /** What the room has said and heard, for handing to a new runner. */
  private history: { who: string; text: string }[] = [];
  /** The runner that last actually took a turn, so we know when to recap. */
  private lastRunnerId: string | null = null;
  private nowFn: () => number;

  constructor(opts: RoutedOptions) {
    this.opts = opts;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  private now(): number {
    return this.nowFn();
  }

  get model(): string {
    const active = this.activeId ? this.runners.get(this.activeId) : null;
    return active ? active.backend : "";
  }

  /* ---------------------------------------------------------------- */
  /* the roster                                                        */
  /* ---------------------------------------------------------------- */

  /** Register the host's in-process backend. Always present, always first. */
  addLocal(name: string, backend: AgentBackend, cwd: string): void {
    this.runners.set("local", {
      id: "local",
      name,
      backend: backend.name,
      cwd,
      busy: false,
      exhausted: false,
      exhaustedUntil: null,
      turns: 0,
      local: true,
      backendRef: backend,
    });
    if (!this.activeId) this.activeId = "local";
    this.opts.onChange();
  }

  add(id: string, name: string, backend: string, cwd: string): void {
    const prior = this.runners.get(id);
    this.runners.set(id, {
      id,
      name,
      backend,
      cwd,
      busy: false,
      exhausted: prior?.exhausted ?? false,
      exhaustedUntil: prior?.exhaustedUntil ?? null,
      turns: prior?.turns ?? 0,
      local: false,
    });
    if (!this.activeId) this.activeId = id;
    this.opts.onNotice(`${name} offered their ${backend} session to the room`);
    /**
     * Tell the room when accepting this runner weakens its own tool gate.
     *
     * `anthropic` and `echo` are the two backends where the room votes on the
     * model's tool calls, because they are the two where mpx owns the loop. A
     * runner runs that loop on its own machine and approves locally, so turns
     * routed there skip the vote that the same turn would have needed at home.
     * A host who set `--policy strict` specifically to have every command
     * voted on should hear that, rather than keep believing it.
     */
    if (this.opts.gatesTools?.(backend) && this.opts.toolsAreGated?.()) {
      this.opts.onNotice(
        `note: ${name}'s ${backend} turns approve their own tool calls — this room votes on tool calls only for turns it runs itself`,
      );
    }
    this.opts.onChange();
  }

  remove(id: string): void {
    const r = this.runners.get(id);
    if (!r) return;
    this.runners.delete(id);
    if (this.activeId === id) this.activeId = this.pick()?.id ?? null;
    // A runner that vanishes mid-turn must not hang the room.
    if (this.pending?.runnerId === id) {
      this.settle({ stopReason: "error", error: `${r.name} left while running the turn`, limited: true });
    }
    this.opts.onChange();
  }

  list(): RunnerInfo[] {
    const now = this.now();
    return [...this.runners.values()]
      .map(({ backendRef: _ignored, ...info }) => ({
        ...info,
        // A limit with a known reset expires on its own.
        exhausted: info.exhausted && !(info.exhaustedUntil !== null && now >= info.exhaustedUntil),
      }))
      .sort((a, b) => (a.local === b.local ? a.name.localeCompare(b.name) : a.local ? -1 : 1));
  }

  get active(): string | null {
    return this.activeId;
  }

  get count(): number {
    return this.runners.size;
  }

  /** Available means present, not busy, and not currently out of capacity. */
  private available(): Runner[] {
    const now = this.now();
    return [...this.runners.values()].filter((r) => {
      if (r.busy) return false;
      if (!r.exhausted) return true;
      if (r.exhaustedUntil !== null && now >= r.exhaustedUntil) {
        r.exhausted = false;
        r.exhaustedUntil = null;
        return true;
      }
      return false;
    });
  }

  /** Prefer staying where we are; otherwise the least-used available runner. */
  private pick(): Runner | null {
    const avail = this.available();
    if (!avail.length) return null;
    const current = this.activeId ? avail.find((r) => r.id === this.activeId) : null;
    if (current) return current;
    return avail.sort((a, b) => a.turns - b.turns || (a.local ? -1 : 1))[0] ?? null;
  }

  /* ---------------------------------------------------------------- */
  /* running a turn                                                    */
  /* ---------------------------------------------------------------- */

  async send(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnResult> {
    this.history.push({ who: "room", text: prompt });

    const tried = new Set<string>();
    let lastError: TurnResult | null = null;

    // Walk the roster until someone has capacity. Each attempt is a whole
    // turn; only a capacity failure moves on, because a genuine bug would
    // fail identically everywhere and burning every account to prove it
    // helps nobody.
    for (let attempt = 0; attempt < this.runners.size + 1; attempt++) {
      if (signal.aborted) return { stopReason: "interrupted" };

      const runner = this.pickUntried(tried);
      if (!runner) break;
      tried.add(runner.id);

      const handoff = this.lastRunnerId !== null && this.lastRunnerId !== runner.id;
      const text = handoff ? this.recapFor(prompt) : prompt;

      if (this.activeId !== runner.id) {
        this.activeId = runner.id;
        this.opts.onChange();
      }
      if (handoff) {
        events.onNotice(`picking up on ${runner.name}'s ${runner.backend} session`);
      }

      // Capture what the assistant says as it streams, so the room can hand
      // the conversation to the next runner without asking anyone for it.
      let heard = "";
      const watched: AgentEvents = {
        ...events,
        onText: (t) => {
          heard += t;
          events.onText(t);
        },
      };

      const result = await this.runOn(runner, text, watched, signal);
      runner.turns += 1;
      this.lastRunnerId = runner.id;

      if (!result.limited) {
        this.noteReply(heard);
        this.opts.onChange();
        return result;
      }

      runner.exhausted = true;
      runner.exhaustedUntil = result.until ?? null;
      const when = result.until ? ` until ${new Date(result.until).toLocaleTimeString()}` : "";
      this.opts.onNotice(`${runner.name}'s ${runner.backend} is out of capacity${when}`);
      this.opts.onChange();
      lastError = result;
      if (signal.aborted) return { stopReason: "interrupted" };
    }

    if (lastError) {
      return {
        ...lastError,
        error:
          this.runners.size > 1
            ? `every account in the room is out of capacity — ${lastError.error ?? ""}`.trim()
            : lastError.error,
      };
    }
    return { stopReason: "error", error: "no runner is available to take this turn" };
  }

  private pickUntried(tried: Set<string>): Runner | null {
    const candidate = this.pick();
    if (candidate && !tried.has(candidate.id)) return candidate;
    return this.available().find((r) => !tried.has(r.id)) ?? null;
  }

  private runOn(
    runner: Runner,
    prompt: string,
    events: AgentEvents,
    signal: AbortSignal,
  ): Promise<TurnResult> {
    runner.busy = true;
    const done = (r: TurnResult) => {
      runner.busy = false;
      return r;
    };

    if (runner.local && runner.backendRef) {
      return runner.backendRef
        .send(prompt, events, signal)
        .then((r) => done(classify(r, this.now())))
        .catch((err) => done(classify({ stopReason: "error", error: (err as Error).message }, this.now())));
    }

    const turnId = `rt_${runner.id}_${runner.turns}_${this.now().toString(36)}`;
    return new Promise<TurnResult>((resolve) => {
      this.pending = { turnId, runnerId: runner.id, events, resolve, usage: {} };
      const onAbort = () => {
        this.opts.dispatch.cancel(runner.id, turnId);
        this.settle({ stopReason: "interrupted" });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const wrapped = (r: TurnResult) => {
        signal.removeEventListener("abort", onAbort);
        resolve(done(r));
      };
      this.pending.resolve = wrapped;
      this.opts.dispatch.start(runner.id, turnId, prompt);
    });
  }

  /* ---------------------------------------------------------------- */
  /* messages coming back from a remote runner                         */
  /* ---------------------------------------------------------------- */

  onOut(runnerId: string, turnId: string, kind: "text" | "thinking", text: string): void {
    const p = this.expect(runnerId, turnId);
    if (!p) return;
    if (kind === "text") p.events.onText(text);
    else p.events.onThinking(text);
  }

  onTool(runnerId: string, turnId: string, toolUseId: string, ok: boolean, preview: string): void {
    const p = this.expect(runnerId, turnId);
    p?.events.onToolResult(toolUseId, ok, preview);
  }

  onRunnerNotice(runnerId: string, turnId: string, text: string): void {
    const p = this.expect(runnerId, turnId);
    p?.events.onNotice(text);
  }

  onEnd(runnerId: string, turnId: string, result: TurnResult): void {
    if (!this.expect(runnerId, turnId)) return;
    // Trust an explicit signal from the runner; fall back to reading the text.
    this.settle(result.limited ? result : classify(result, this.now()));
  }

  /** Ignore anything from a runner or turn we are not currently waiting on. */
  private expect(runnerId: string, turnId: string): Pending | null {
    const p = this.pending;
    if (!p || p.runnerId !== runnerId || p.turnId !== turnId) return null;
    return p;
  }

  private settle(result: TurnResult): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    p.resolve(result);
  }

  /* ---------------------------------------------------------------- */
  /* carrying the conversation across a handoff                        */
  /* ---------------------------------------------------------------- */

  private noteReply(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.history.push({ who: "assistant", text: trimmed });
  }

  /**
   * Build the prompt for a runner that was not part of what came before.
   *
   * The room owns the only complete record of the session, so it is the room
   * that carries it across. This is a summary, not a transplant: the new tool
   * has none of the previous one's internal state, and the recap says so
   * rather than letting the model assume continuity it does not have.
   */
  recapFor(prompt: string): string {
    const budget = this.opts.recapChars ?? 12_000;
    const prior = this.history.slice(0, -1); // the current prompt is added last
    if (!prior.length) return prompt;

    const lines: string[] = [];
    let used = 0;
    for (let i = prior.length - 1; i >= 0; i--) {
      const entry = prior[i]!;
      const label = entry.who === "room" ? "The room asked" : "You answered";
      const body = entry.text.length > 1800 ? entry.text.slice(0, 1800) + " […]" : entry.text;
      const chunk = `${label}: ${body}`;
      if (used + chunk.length > budget) break;
      used += chunk.length;
      lines.unshift(chunk);
    }
    if (!lines.length) return prompt;

    return [
      "[Session handoff]",
      "You are picking up a shared session that was running elsewhere and ran out of capacity. Below is the conversation so far, summarised by the room. You do not have the previous session's tool results or file state — re-read anything you need rather than assuming it is still true.",
      "",
      ...lines,
      "",
      "[End of handoff. The room's next message follows.]",
      "",
      prompt,
    ].join("\n");
  }

  async close(): Promise<void> {
    const local = this.runners.get("local")?.backendRef;
    this.runners.clear();
    await local?.close();
  }
}
