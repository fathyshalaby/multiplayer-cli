import { execFile } from "node:child_process";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

/**
 * One parallel attempt: a git branch, its own checkout, and the directory the
 * agent is pointed at (which mirrors the room's cwd inside the repo, so a room
 * hosted in `packages/api` gets a lane rooted there too).
 */
export interface Lane {
  id: string;
  branch: string;
  /** Root of the lane's checkout. */
  dir: string;
  /** Where the agent runs — `dir` plus the room's path inside the repo. */
  cwd: string;
}

export interface LaneStat {
  /** True when the lane actually changed something worth voting on. */
  changed: boolean;
  commit: string | null;
  files: number;
  insertions: number;
  deletions: number;
  /** `3 files changed, +42 −7`, or `no changes`. */
  summary: string;
  /** Per-file diffstat, for the seat that wants to look before voting. */
  detail: string;
  /**
   * The paths this lane touched.
   *
   * Kept apart from `detail` rather than parsed back out of it: a diffstat is
   * shaped for reading, and it abbreviates long paths and writes renames as
   * `a => b`. Overlap between lanes is decided on these.
   */
  paths: string[];
}

export interface RepoInfo {
  root: string;
  head: string;
  branch: string;
  /** Uncommitted work in the host's checkout, which lanes will not see. */
  dirty: boolean;
  /** The room's cwd relative to the repo root; "" when they are the same. */
  prefix: string;
}

/** Anything that goes wrong here is reported, never thrown at the room. */
export type Fallible<T> = { ok: true; value: T } | { ok: false; error: string };

export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Fallible<string>> {
  return new Promise((done) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 8 << 20, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => {
        if (err) {
          const text = `${stderr || stdout || (err as Error).message}`.trim();
          done({ ok: false, error: text || `git ${args[0]} failed` });
          return;
        }
        done({ ok: true, value: stdout.trim() });
      },
    );
  });
}

/**
 * Work out whether lanes are even possible here.
 *
 * Lanes are branches, so they need a repository with at least one commit. A
 * room in a plain directory is not a failure — it just cannot race, and saying
 * so up front is better than failing halfway through a turn.
 */
export async function inspectRepo(cwd: string): Promise<Fallible<RepoInfo>> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) return { ok: false, error: `${cwd} is not a git repository — lanes need one to branch from` };
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (!head.ok) {
    return { ok: false, error: "this repository has no commits yet — lanes need something to branch from" };
  }
  const status = await git(cwd, ["status", "--porcelain"]);
  const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const top = resolve(root.value);
  return {
    ok: true,
    value: {
      root: top,
      head: head.value,
      branch: branch.ok ? branch.value : "HEAD",
      dirty: status.ok ? status.value.length > 0 : false,
      prefix: relative(top, resolve(cwd)),
    },
  };
}

export interface WorktreesOptions {
  repo: RepoInfo;
  /** Distinguishes one room's lanes from another's on the same machine. */
  roomName: string;
  /** Where checkouts live. Defaults to a directory under the system temp dir. */
  baseDir?: string;
  /** Suffix keeping two races in the same room from colliding. */
  tag: string;
}

/**
 * Creates and disposes of the checkouts a race runs in.
 *
 * Everything is scoped to one race: the branches are named after it, the
 * directories live under it, and closing the race takes the directories away
 * again. Branches outlive the race on purpose — a lane nobody voted for is
 * still work someone might want, and `git branch -D` is a decision for the
 * person whose repository it is.
 */
export class Worktrees {
  readonly repo: RepoInfo;
  readonly base: string;
  private lanes = new Map<string, Lane>();
  private slug: string;
  /** Set when the repo has no committer identity, so lane commits still work. */
  private env: NodeJS.ProcessEnv | undefined;

  constructor(opts: WorktreesOptions) {
    this.repo = opts.repo;
    this.slug = `${slugify(opts.roomName)}/${opts.tag}`;
    this.base = opts.baseDir ?? join(tmpdir(), "mpx-lanes", slugify(opts.roomName), opts.tag);
  }

  /** Add one lane. Ids are short so `/race` output stays readable: A, B, C. */
  async add(id: string): Promise<Fallible<Lane>> {
    const branch = `mpx/${this.slug}/${id.toLowerCase()}`;
    const dir = join(this.base, id.toLowerCase());
    await mkdir(this.base, { recursive: true });
    const added = await git(this.repo.root, ["worktree", "add", "-b", branch, dir, this.repo.head]);
    if (!added.ok) return { ok: false, error: added.error };
    const lane: Lane = { id, branch, dir, cwd: this.repo.prefix ? join(dir, this.repo.prefix) : dir };
    this.lanes.set(id, lane);
    return { ok: true, value: lane };
  }

  get(id: string): Lane | undefined {
    return this.lanes.get(id);
  }

  list(): Lane[] {
    return [...this.lanes.values()];
  }

  /**
   * Turn whatever the agent left behind into a commit.
   *
   * Committing is what makes a lane reviewable and landable at all: without it
   * there is nothing to diff against, nothing to merge, and `git worktree
   * remove` refuses to clean up.
   */
  async commit(lane: Lane, message: string): Promise<Fallible<LaneStat>> {
    const staged = await git(lane.dir, ["add", "-A"]);
    if (!staged.ok) return { ok: false, error: staged.error };

    const diff = await git(lane.dir, ["diff", "--cached", "--shortstat"]);
    if (diff.ok && !diff.value) {
      return { ok: true, value: empty() };
    }

    await this.ensureIdentity();
    const done = await git(lane.dir, ["commit", "-m", message], this.env);
    if (!done.ok) return { ok: false, error: done.error };
    return this.stat(lane);
  }

  /** Measure a lane against the commit every lane started from. */
  async stat(lane: Lane): Promise<Fallible<LaneStat>> {
    const head = await git(lane.dir, ["rev-parse", "HEAD"]);
    if (!head.ok) return { ok: false, error: head.error };
    if (head.value === this.repo.head) return { ok: true, value: empty() };

    const range = `${this.repo.head}..HEAD`;
    const short = await git(lane.dir, ["diff", "--shortstat", range]);
    const detail = await git(lane.dir, ["diff", "--stat", range]);
    const names = await git(lane.dir, ["diff", "--name-only", range]);
    const counts = parseShortstat(short.ok ? short.value : "");
    return {
      ok: true,
      value: {
        changed: true,
        commit: head.value.slice(0, 8),
        ...counts,
        summary: renderStat(counts),
        detail: detail.ok ? detail.value : "",
        paths: names.ok ? names.value.split("\n").map((l) => l.trim()).filter(Boolean) : [],
      },
    };
  }

  /**
   * Merge a lane into the checkout the room is hosted in.
   *
   * A merge commit rather than a fast-forward or a squash: the lane branch
   * stays in the history as its own thing, so "we raced three attempts and
   * took B" is still legible in `git log` a month later.
   */
  async land(lane: Lane): Promise<Fallible<string>> {
    const status = await git(this.repo.root, ["status", "--porcelain"]);
    if (status.ok && status.value) {
      return {
        ok: false,
        error: `the host's checkout has uncommitted changes — commit or stash them, then merge ${lane.branch} by hand`,
      };
    }
    await this.ensureIdentity();
    const merged = await git(
      this.repo.root,
      ["merge", "--no-ff", "--no-edit", "-m", `Land lane ${lane.id} (${lane.branch})`, lane.branch],
      this.env,
    );
    if (!merged.ok) {
      // Leave the conflict in place: resolving it is the room's business, and
      // silently aborting would throw away work they just voted for.
      return { ok: false, error: `merge failed — ${firstLine(merged.error)}` };
    }
    return { ok: true, value: merged.value };
  }

  /**
   * Drop every checkout. Branches are left alone, and reported so nobody has
   * to go digging for the attempt the room voted down.
   */
  async close(): Promise<string[]> {
    const kept: string[] = [];
    for (const lane of this.lanes.values()) {
      const removed = await git(this.repo.root, ["worktree", "remove", "--force", lane.dir]);
      if (!removed.ok) await rm(lane.dir, { recursive: true, force: true }).catch(() => {});
      kept.push(lane.branch);
    }
    await git(this.repo.root, ["worktree", "prune"]);
    await rm(this.base, { recursive: true, force: true }).catch(() => {});
    // Leave no empty scaffolding behind in the temp directory. Another race in
    // the same room still holds its own subdirectory, so this fails harmlessly.
    await rmdir(dirname(this.base)).catch(() => {});
    this.lanes.clear();
    return kept;
  }

  /**
   * `git commit` refuses to run without a name and an email. Most checkouts
   * have them; CI containers and fresh machines often do not, and a race is a
   * bad moment to discover it.
   */
  private async ensureIdentity(): Promise<void> {
    if (this.env !== undefined) return;
    const email = await git(this.repo.root, ["config", "user.email"]);
    const name = await git(this.repo.root, ["config", "user.name"]);
    this.env =
      email.ok && email.value && name.ok && name.value
        ? {}
        : { GIT_AUTHOR_NAME: "multiplayer-cli", GIT_AUTHOR_EMAIL: "lanes@multiplayer-cli.invalid",
            GIT_COMMITTER_NAME: "multiplayer-cli", GIT_COMMITTER_EMAIL: "lanes@multiplayer-cli.invalid" };
  }
}

function empty(): LaneStat {
  return { changed: false, commit: null, files: 0, insertions: 0, deletions: 0, summary: "no changes", detail: "", paths: [] };
}

/** `3 files changed, 42 insertions(+), 7 deletions(-)` -> numbers. */
export function parseShortstat(s: string): { files: number; insertions: number; deletions: number } {
  const num = (re: RegExp) => {
    const m = re.exec(s);
    return m ? Number(m[1]) : 0;
  };
  return {
    files: num(/(\d+) files? changed/),
    insertions: num(/(\d+) insertions?\(\+\)/),
    deletions: num(/(\d+) deletions?\(-\)/),
  };
}

export function renderStat(c: { files: number; insertions: number; deletions: number }): string {
  if (!c.files) return "no changes";
  const bits = [`${c.files} file${c.files === 1 ? "" : "s"}`];
  if (c.insertions) bits.push(`+${c.insertions}`);
  if (c.deletions) bits.push(`-${c.deletions}`);
  return bits.join(" ");
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "room";
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim()) ?? s;
}
