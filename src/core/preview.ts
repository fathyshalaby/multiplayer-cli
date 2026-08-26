import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer } from "node:net";

/**
 * Running previews, one per lane.
 *
 * A diffstat is a fine ballot for backend work and a poor one for anything a
 * person is meant to look at. `3 files changed, +120 −30` does not tell a room
 * whether the page is right. So each lane can be *started* as well as read: its
 * own checkout, its own port, its own running copy of the app, and the room
 * votes on the thing rather than on a description of it.
 *
 * Two details here are load-bearing and both are about not leaving a mess
 * behind. Ports are probed before they are handed out, because a lane whose
 * server silently lost a race for port 3001 is worse than a lane with no
 * preview at all. And previews are started detached so the whole process group
 * can be killed: `npm run dev` is a shell that spawns a server, and killing the
 * shell alone orphans the server, which then holds the port until someone finds
 * it with `lsof`.
 */

export interface PreviewOptions {
  /**
   * Shell command that starts the app. `{port}` is replaced with the lane's
   * port, and `PORT` is set in the environment for the many tools that read it.
   */
  command: string;
  /** Where port hunting starts. Each lane takes the next free one. */
  basePort: number;
  /** The hostname put in the URL the room is shown. */
  host: string;
  /** How long to wait for something to answer on the port. */
  readyMs: number;
  /** Injected so tests do not have to really wait. */
  now?: () => number;
}

export interface PreviewHandle {
  laneId: string;
  port: number;
  url: string;
  child: ChildProcess;
}

export const DEFAULT_BASE_PORT = 4173;
export const DEFAULT_READY_MS = 60_000;
export const DEFAULT_HOST = "127.0.0.1";

/** Substitute the port into a command. Kept separate so it can be tested alone. */
export function renderCommand(command: string, port: number): string {
  return command.replace(/\{port\}/g, String(port));
}

/**
 * Is anything listening here?
 *
 * Used both to hunt for a free port and to decide a preview is ready, which is
 * why it answers a plain question rather than throwing.
 */
export function probe(port: number, host = DEFAULT_HOST, timeoutMs = 400): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host });
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(answer);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/** Can we bind here? A free port answers yes; one held by anyone else says no. */
function bindable(port: number, host = DEFAULT_HOST): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.once("listening", () => server.close(() => done(true)));
    server.listen(port, host);
  });
}

/**
 * The first port at or above `from` that nothing holds.
 *
 * There is an unavoidable race between finding a free port and the preview
 * binding it. Probing narrows it to microseconds and, more importantly, means
 * two lanes in the same race never pick the same number — which is the
 * collision that actually happens.
 */
export async function freePort(from: number, taken: Set<number>, host = DEFAULT_HOST): Promise<number | null> {
  for (let port = from; port < from + 200; port++) {
    if (taken.has(port)) continue;
    if (await bindable(port, host)) return port;
  }
  return null;
}

export class Previews {
  private opts: PreviewOptions;
  private running = new Map<string, PreviewHandle>();
  private ports = new Set<number>();

  constructor(opts: PreviewOptions) {
    this.opts = opts;
  }

  get(laneId: string): PreviewHandle | undefined {
    return this.running.get(laneId);
  }

  /**
   * Start one lane's preview and wait until it answers.
   *
   * A preview that never comes up is the lane's problem, not the room's: it is
   * reported and the lane stays votable on its diff alone.
   */
  async start(
    laneId: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ ok: true; value: PreviewHandle } | { ok: false; error: string }> {
    if (this.running.has(laneId)) return { ok: false, error: `lane ${laneId} already has a preview` };

    const port = await freePort(this.opts.basePort, this.ports);
    if (port === null) return { ok: false, error: "no free port for a preview" };
    this.ports.add(port);

    const command = renderCommand(this.opts.command, port);
    const child = spawn(command, {
      cwd,
      shell: true,
      // Its own process group, so stopping it stops the server it spawned and
      // not just the shell that spawned it.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: String(port), FORCE_COLOR: "0" },
    });

    // A preview must never be the reason this process cannot exit. It is
    // detached and owned explicitly, so the event loop should not count it —
    // nor its pipes, which outlive the shell and would otherwise hold the room
    // open on behalf of a server nobody can see any more.
    child.unref();
    // Typed as Readable, but at runtime these are pipes, and a pipe is a handle
    // the loop counts. There is no unref on the declared type, hence the cast.
    for (const stream of [child.stdout, child.stderr]) {
      (stream as unknown as { unref?: () => void } | null)?.unref?.();
    }

    let tail = "";
    const keep = (b: Buffer) => {
      tail = (tail + b.toString()).slice(-2000);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);

    const handle: PreviewHandle = {
      laneId,
      port,
      url: `http://${this.opts.host}:${port}`,
      child,
    };
    this.running.set(laneId, handle);

    const ready = await this.waitForPort(port, child, signal);
    if (!ready.ok) {
      await this.stop(laneId);
      const why = tail.trim().split("\n").slice(-3).join(" / ").slice(0, 300);
      return { ok: false, error: why ? `${ready.error} — ${why}` : ready.error };
    }
    return { ok: true, value: handle };
  }

  /**
   * Poll until the port answers, the process dies, or the clock runs out.
   *
   * Watching the child matters: a command that exits immediately (a typo, a
   * missing dependency) should be reported in milliseconds rather than after
   * the full timeout.
   */
  private async waitForPort(
    port: number,
    child: ChildProcess,
    signal: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const now = this.opts.now ?? (() => Date.now());
    const deadline = now() + this.opts.readyMs;
    let dead = false;
    child.once("exit", () => {
      dead = true;
    });

    while (now() < deadline) {
      if (signal.aborted) return { ok: false, error: "interrupted" };
      if (await probe(port, this.opts.host === "0.0.0.0" ? DEFAULT_HOST : this.opts.host)) return { ok: true };
      // The shell exiting is not the same as the app failing — it may have
      // forked the real server and stepped aside. Give up only once nothing
      // from this command is left running at all.
      if (dead && !groupAlive(child.pid)) {
        return { ok: false, error: "the preview command exited without listening" };
      }
      await sleep(150);
    }
    return { ok: false, error: `nothing listened on ${port} within ${Math.round(this.opts.readyMs / 1000)}s` };
  }

  /** Stop one preview and give its port back. Safe to call twice. */
  async stop(laneId: string): Promise<void> {
    const handle = this.running.get(laneId);
    if (!handle) return;
    this.running.delete(laneId);
    this.ports.delete(handle.port);
    await killGroup(handle.child);
  }

  /** Stop everything. Called when a race ends, however it ends. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }

  get count(): number {
    return this.running.size;
  }
}

/**
 * Kill a detached child and everything it spawned.
 *
 * The trap here is that the child is a *shell* — `spawn(cmd, {shell: true})`
 * runs `/bin/sh -c cmd`, and unless the command happens to `exec`, the real
 * server is the shell's child rather than ours. A shell dies obediently on
 * SIGTERM. Its children need not, and an orphaned dev server keeps the port and
 * keeps the parent's stdout pipe open forever.
 *
 * So the child's `exit` event proves only that the shell is gone. What decides
 * whether we are done is whether anything is left in the process group.
 */
export async function killGroup(child: ChildProcess, graceMs = 2000): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;

  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

  signalGroup(pid, "SIGTERM");
  await Promise.race([exited, sleep(graceMs)]);

  // Only while something is still in the group. An emptied group id can be
  // reused by an unrelated process, and SIGKILL to a recycled one would hit a
  // stranger — which is a far worse bug than a leaked port.
  if (groupAlive(pid)) {
    signalGroup(pid, "SIGKILL");
    await untilGroupGone(pid, 2000);
  }
}

/**
 * Is anything still in this process group?
 *
 * Signal 0 asks the kernel the question without delivering anything, which is
 * the only way to tell "already reaped" from "ignoring me".
 */
function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the group to actually empty.
 *
 * SIGKILL is not instantaneous, and the caller's next move is usually to hand
 * the port to another lane or delete the directory the server is sitting in.
 * Returning before the kernel has finished would make both of those flaky.
 */
async function untilGroupGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return;
    await sleep(25);
  }
}

/**
 * Signal a whole process group, falling back to the one process.
 *
 * The negative pid is the group. If the child was never detached — or the group
 * is already gone — that throws, and signalling just the child is the best left
 * to do.
 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Deliberately *not* unref'd.
 *
 * Every use of this is inside an await that something is waiting on — a
 * readiness poll, a grace period before SIGKILL. An unref'd timer lets the
 * event loop drain while that await is still outstanding, and the process
 * exits mid-poll.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
