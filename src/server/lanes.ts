import type { LaneInfo } from "../protocol.js";
import type { AgentBackend, TurnResult } from "../agent/types.js";
import { Worktrees, type Lane, type RepoInfo } from "../core/worktree.js";
import { Previews, type PreviewOptions } from "../core/preview.js";

export interface RaceOptions {
  repo: RepoInfo;
  roomName: string;
  turnId: string;
  prompt: string;
  /** How many parallel attempts to open. */
  count: number;
  /** One backend per lane, pointed at that lane's checkout. */
  makeBackend(lane: Lane): AgentBackend;
  /** Shell command run in each lane before the agent starts, e.g. `npm ci`. */
  setup?: string | null;
  /**
   * Start each finished lane so the room can look at it, not just read it.
   *
   * Null when the room has no preview command, which is the default: most work
   * has nothing to look at, and starting N dev servers is not free.
   */
  preview?: PreviewOptions | null;
  /**
   * A prompt per lane, keyed by lane id, for a split.
   *
   * A race leaves this empty and every lane gets `prompt`. A split fills it,
   * and lanes then differ in what they were asked rather than only in what
   * they came back with.
   */
  prompts?: Record<string, string>;
  onLaneChange(lanes: LaneInfo[]): void;
  onDelta(laneId: string, kind: "text" | "thinking", text: string): void;
  onToolResult(laneId: string, toolUseId: string, ok: boolean, preview: string): void;
  onNotice(text: string): void;
  /** Where checkouts go. Tests point this at a scratch directory. */
  baseDir?: string;
  now?: () => number;
}

/**
 * Lanes are named for people to say out loud, not for a database.
 *
 * Exported because a split has to know which id each of its pieces will get
 * before the race opens, and two lists that must agree are one list.
 */
export const LANE_IDS = ["A", "B", "C", "D", "E", "F"];

/**
 * One race: the same prompt attempted N times, each in its own worktree.
 *
 * The point is not that more agents are better. It is that "which of these is
 * right" is a much easier question for a room to answer than "what should we
 * ask for", and it is answerable by looking at diffs rather than by arguing
 * about an approach nobody has tried yet.
 *
 * A race owns its checkouts and disposes of them; the branches it leaves
 * behind are the durable artifact.
 */
export class Race {
  readonly turnId: string;
  private opts: RaceOptions;
  private trees: Worktrees;
  private infos = new Map<string, LaneInfo>();
  private lanes = new Map<string, Lane>();
  private backends = new Map<string, AgentBackend>();
  private previews: Previews | null;
  /** Preview startups still in flight, so closing can wait for them to settle. */
  private starting = new Set<Promise<void>>();
  private nowFn: () => number;
  private done = false;

  constructor(opts: RaceOptions) {
    this.opts = opts;
    this.turnId = opts.turnId;
    this.nowFn = opts.now ?? (() => Date.now());
    this.previews = opts.preview ? new Previews(opts.preview) : null;
    this.trees = new Worktrees({
      repo: opts.repo,
      roomName: opts.roomName,
      tag: opts.turnId,
      ...(opts.baseDir ? { baseDir: opts.baseDir } : {}),
    });
  }

  list(): LaneInfo[] {
    return [...this.infos.values()];
  }

  laneOf(id: string): Lane | undefined {
    return this.lanes.get(id);
  }

  /**
   * Open every lane, then run them all at once.
   *
   * A lane that fails to open, fails to run, or produces nothing is reported
   * rather than aborting the race: two useful attempts out of three is still a
   * result the room can vote on.
   */
  async run(signal: AbortSignal): Promise<LaneInfo[]> {
    const ids = LANE_IDS.slice(0, this.opts.count);
    for (const id of ids) {
      const info: LaneInfo = {
        id,
        turnId: this.turnId,
        branch: "",
        dir: "",
        backend: "",
        state: "running",
        summary: "",
        detail: "",
        commit: null,
        proposalId: null,
        startedAt: this.now(),
        endedAt: null,
      };
      this.infos.set(id, info);
      const added = await this.trees.add(id);
      if (!added.ok) {
        this.finish(info, "failed", added.error);
        continue;
      }
      this.lanes.set(id, added.value);
      info.branch = added.value.branch;
      info.dir = added.value.cwd;
      // Only when it differs from its siblings: a race's lanes all share the
      // turn's prompt, and repeating it on each of them says nothing.
      const own = this.opts.prompts?.[id];
      if (own !== undefined) info.prompt = own;
    }
    this.publish();

    await Promise.all([...this.lanes.keys()].map((id) => this.oneLane(id, signal)));
    this.done = true;
    this.publish();
    return this.list();
  }

  private async oneLane(id: string, signal: AbortSignal): Promise<void> {
    const info = this.infos.get(id)!;
    const lane = this.lanes.get(id)!;

    if (this.opts.setup) {
      const setup = await runShell(this.opts.setup, lane.cwd, signal);
      if (!setup.ok) {
        this.finish(info, "failed", `setup failed: ${setup.error}`);
        return;
      }
    }

    const backend = this.opts.makeBackend(lane);
    this.backends.set(id, backend);
    info.backend = backend.name;

    const result = await backend
      .send(
        this.promptFor(id),
        {
          onText: (text) => text && this.opts.onDelta(id, "text", text),
          onThinking: (text) => text && this.opts.onDelta(id, "thinking", text),
          // Lanes work on a throwaway branch, so there is nothing for the room
          // to protect by voting on each tool call. The vote that matters is
          // the one at the end, on the diff.
          onToolRequest: () => Promise.resolve({ allow: true, reason: `lane ${id}` }),
          onToolResult: (toolUseId, ok, preview) => this.opts.onToolResult(id, toolUseId, ok, preview),
          onNotice: (text) => this.opts.onNotice(`lane ${id}: ${text}`),
        },
        signal,
      )
      .catch((err): TurnResult => ({ stopReason: "error", error: (err as Error)?.message ?? String(err) }));

    await backend.close().catch(() => {});

    if (signal.aborted) {
      this.finish(info, "failed", "interrupted");
      return;
    }
    if (result.error) {
      // Still commit: an agent that errored halfway may have left useful work,
      // and a lane with a diff is worth showing even if it did not finish.
      await this.commit(info, lane, signal);
      if (info.state === "empty") this.finish(info, "failed", result.error);
      else info.error = result.error;
      this.publish();
      return;
    }
    await this.commit(info, lane, signal);
    this.publish();
  }

  private async commit(info: LaneInfo, lane: Lane, signal: AbortSignal): Promise<void> {
    const message = `lane ${info.id}: ${firstLine(this.promptFor(info.id)).slice(0, 60)}`;
    const stat = await this.trees.commit(lane, message);
    if (!stat.ok) {
      this.finish(info, "failed", stat.error);
      return;
    }
    if (!stat.value.changed) {
      this.finish(info, "empty", undefined);
      return;
    }
    info.summary = stat.value.summary;
    info.detail = stat.value.detail;
    info.paths = stat.value.paths;
    info.commit = stat.value.commit;
    this.finish(info, "done", undefined);
    // Deliberately not awaited. A dev server can take a minute to answer, and
    // the room should be reading diffs and voting during that minute rather
    // than staring at a blank screen; the preview arrives as an update.
    this.beginPreview(info, lane, signal);
  }

  /**
   * Bring up one lane's preview in the background.
   *
   * Failure here is reported on the lane and nowhere else. A preview that will
   * not start is a shame, not a reason to withdraw an otherwise good diff from
   * the vote.
   */
  private beginPreview(info: LaneInfo, lane: Lane, signal: AbortSignal): void {
    const previews = this.previews;
    if (!previews) return;
    info.preview = { state: "starting", url: null, port: null };
    this.publish();

    const task = previews
      .start(info.id, lane.cwd, signal)
      .then((started) => {
        // The lane may have been landed, discarded or closed while we waited,
        // and reviving its preview at that point would leave a stray process.
        if (!this.infos.has(info.id) || info.preview?.state === "stopped") return;
        info.preview = started.ok
          ? { state: "ready", url: started.value.url, port: started.value.port }
          : { state: "failed", url: null, port: null, error: started.error };
        this.publish();
      })
      .catch((err) => {
        info.preview = { state: "failed", url: null, port: null, error: (err as Error)?.message ?? String(err) };
        this.publish();
      })
      .finally(() => {
        this.starting.delete(task);
      });
    this.starting.add(task);
  }

  /** What this lane was asked for: its own prompt in a split, the turn's in a race. */
  private promptFor(id: string): string {
    return this.opts.prompts?.[id] ?? this.opts.prompt;
  }

  /** Stop one lane's preview and say so. */
  private async stopPreview(id: string): Promise<void> {
    if (!this.previews) return;
    await this.previews.stop(id);
    const info = this.infos.get(id);
    if (info?.preview) info.preview = { state: "stopped", url: null, port: null };
  }

  /** Merge one lane into the host's checkout. */
  async land(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const lane = this.lanes.get(id);
    const info = this.infos.get(id);
    if (!lane || !info) return { ok: false, error: `no lane ${id}` };
    const merged = await this.trees.land(lane);
    if (!merged.ok) return { ok: false, error: merged.error };
    info.state = "landed";
    this.publish();
    return { ok: true };
  }

  /**
   * Drop one lane, leaving its siblings alone.
   *
   * `markDiscarded` is the race's version — everything but the winner. A split
   * rejects lanes one at a time, and the others are still live questions.
   */
  async discard(id: string): Promise<void> {
    const info = this.infos.get(id);
    if (!info || info.state !== "done") return;
    info.state = "discarded";
    await this.stopPreview(id);
    this.publish();
  }

  markDiscarded(except?: string): void {
    const dropped: string[] = [];
    for (const info of this.infos.values()) {
      if (info.id !== except && info.state === "done") {
        info.state = "discarded";
        dropped.push(info.id);
      }
    }
    // A discarded lane's preview is a server nobody is going to look at again,
    // holding a port the next race will want.
    void Promise.all(dropped.map((id) => this.stopPreview(id))).then(() => this.publish());
    this.publish();
  }

  /** Drop the checkouts. Returns the branches left behind, for the record. */
  async close(): Promise<string[]> {
    for (const backend of this.backends.values()) await backend.close().catch(() => {});
    this.backends.clear();
    // Order matters. Previews run *inside* the checkouts, so they have to be
    // stopped before the worktrees are removed out from under them — otherwise
    // a dev server is left running on a directory that no longer exists, still
    // holding its port. Startups already in flight are settled first for the
    // same reason: one that lands after this point would spawn into nothing.
    await Promise.allSettled([...this.starting]);
    if (this.previews) await this.previews.stopAll();
    for (const info of this.infos.values()) {
      if (info.preview && info.preview.state !== "failed") {
        info.preview = { state: "stopped", url: null, port: null };
      }
    }
    return this.trees.close();
  }

  get finished(): boolean {
    return this.done;
  }

  /** Lanes that produced something worth voting on. */
  landable(): LaneInfo[] {
    return this.list().filter((l) => l.state === "done");
  }

  private finish(info: LaneInfo, state: LaneInfo["state"], error: string | undefined): void {
    info.state = state;
    info.endedAt = this.now();
    if (error) info.error = error;
  }

  private publish(): void {
    this.opts.onLaneChange(this.list());
  }

  private now(): number {
    return this.nowFn();
  }
}

/** Run a lane's setup command. Best-effort: its failure is the lane's, not the room's. */
async function runShell(cmd: string, cwd: string, signal: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((done) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (b: Buffer) => {
      tail = (tail + b.toString()).slice(-2000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      done({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      done(code === 0 ? { ok: true } : { ok: false, error: `exit ${code}\n${tail.trim()}` });
    });
  });
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim()) ?? s;
}
