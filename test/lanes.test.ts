import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport } from "../src/server/transport.js";
import { Connection } from "../src/client/connection.js";
import { resolvePreset } from "../src/core/policy.js";
import { Worktrees, git, inspectRepo, parseShortstat, renderStat } from "../src/core/worktree.js";
import { probe } from "../src/core/preview.js";
import { parse } from "../src/client/commands.js";
import type { LaneInfo, ServerMessage } from "../src/protocol.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../src/agent/types.js";

const ctx = { defaultProposal: () => "#1" };

/* ------------------------------------------------------------------ */
/* a scratch repository                                                */
/* ------------------------------------------------------------------ */

async function scratchRepo(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mpx-repo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "-q", "-b", "main"]);
  await git(dir, ["config", "user.email", "test@example.invalid"]);
  await git(dir, ["config", "user.name", "test"]);
  await writeFile(join(dir, "README.md"), "# scratch\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-qm", "first"]);
  return dir;
}

/**
 * A backend that edits a file instead of talking, so a race produces real
 * diffs. Each lane writes something different, which is the whole point: the
 * room is choosing between attempts, not confirming one.
 */
class Editor implements AgentBackend {
  readonly name = "editor";
  readonly model = "editor-1";
  constructor(
    private cwd: string,
    private lane: string,
    private mode: "write" | "nothing" | "fail" = "write",
  ) {}

  async send(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnResult> {
    events.onText(`lane ${this.lane} working on ${prompt.slice(0, 10)}`);
    if (signal.aborted) return { stopReason: "interrupted" };
    if (this.mode === "fail") return { stopReason: "error", error: `lane ${this.lane} blew up` };
    if (this.mode === "nothing") return { stopReason: "end_turn" };
    await writeFile(join(this.cwd, "answer.txt"), `written by lane ${this.lane}\n`);
    return { stopReason: "end_turn", usage: { output_tokens: 3 } };
  }
  async close(): Promise<void> {}
}

/* ------------------------------------------------------------------ */
/* the git plumbing                                                    */
/* ------------------------------------------------------------------ */

test("a directory that is not a repository says so instead of failing later", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mpx-plain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const found = await inspectRepo(dir);
  assert.equal(found.ok, false);
  assert.match((found as { error: string }).error, /not a git repository/);
});

test("a fresh repository with no commits cannot be branched from", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mpx-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "-q", "-b", "main"]);
  const found = await inspectRepo(dir);
  assert.equal(found.ok, false);
  assert.match((found as { error: string }).error, /no commits yet/);
});

test("a room in a subdirectory gets lanes rooted at the same subdirectory", async (t) => {
  const root = await scratchRepo(t);
  await mkdir(join(root, "packages", "api"), { recursive: true });
  await writeFile(join(root, "packages", "api", "index.ts"), "export {};\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-qm", "sub"]);

  const found = await inspectRepo(join(root, "packages", "api"));
  assert.equal(found.ok, true);
  const repo = (found as { value: Awaited<ReturnType<typeof inspectRepo>> extends never ? never : any }).value;
  assert.equal(repo.prefix, join("packages", "api"));

  const trees = new Worktrees({ repo, roomName: "sub", tag: "t1" });
  t.after(async () => await trees.close());
  const lane = await trees.add("A");
  assert.equal(lane.ok, true);
  const value = (lane as { value: { cwd: string; dir: string } }).value;
  assert.equal(value.cwd, join(value.dir, "packages", "api"));
});

test("a lane that changes nothing is reported as empty, not as a failure", async (t) => {
  const root = await scratchRepo(t);
  const repo = (await inspectRepo(root)) as { ok: true; value: any };
  const trees = new Worktrees({ repo: repo.value, roomName: "quiet", tag: "t1" });
  t.after(async () => await trees.close());
  const lane = (await trees.add("A")) as { ok: true; value: any };
  const stat = (await trees.commit(lane.value, "nothing")) as { ok: true; value: any };
  assert.equal(stat.value.changed, false);
  assert.equal(stat.value.summary, "no changes");
});

test("a lane commits its work, and landing it merges into the host's checkout", async (t) => {
  const root = await scratchRepo(t);
  const repo = (await inspectRepo(root)) as { ok: true; value: any };
  const trees = new Worktrees({ repo: repo.value, roomName: "land", tag: "t1" });
  t.after(async () => await trees.close());

  const lane = (await trees.add("A")) as { ok: true; value: any };
  await writeFile(join(lane.value.cwd, "new.txt"), "hello from the lane\n");
  const stat = (await trees.commit(lane.value, "lane A")) as { ok: true; value: any };
  assert.equal(stat.value.changed, true);
  assert.equal(stat.value.files, 1);
  assert.match(stat.value.summary, /1 file/);

  // The host's checkout has not seen it yet — that is what landing is for.
  await assert.rejects(() => readFile(join(root, "new.txt"), "utf8"));

  const landed = await trees.land(lane.value);
  assert.equal(landed.ok, true, JSON.stringify(landed));
  assert.equal(await readFile(join(root, "new.txt"), "utf8"), "hello from the lane\n");
});

test("landing refuses to merge over uncommitted work, and says where the branch is", async (t) => {
  const root = await scratchRepo(t);
  const repo = (await inspectRepo(root)) as { ok: true; value: any };
  const trees = new Worktrees({ repo: repo.value, roomName: "dirty", tag: "t1" });
  t.after(async () => await trees.close());

  const lane = (await trees.add("A")) as { ok: true; value: any };
  await writeFile(join(lane.value.cwd, "new.txt"), "lane work\n");
  await trees.commit(lane.value, "lane A");

  await writeFile(join(root, "README.md"), "# edited while the race ran\n");
  const landed = await trees.land(lane.value);
  assert.equal(landed.ok, false);
  assert.match((landed as { error: string }).error, /uncommitted changes/);
  assert.match((landed as { error: string }).error, /mpx\/dirty\/t1\/a/);
});

test("closing a race removes the checkouts but keeps the branches", async (t) => {
  const root = await scratchRepo(t);
  const repo = (await inspectRepo(root)) as { ok: true; value: any };
  const trees = new Worktrees({ repo: repo.value, roomName: "keep", tag: "t1" });
  const lane = (await trees.add("A")) as { ok: true; value: any };
  await writeFile(join(lane.value.cwd, "x.txt"), "x\n");
  await trees.commit(lane.value, "lane A");

  const kept = await trees.close();
  assert.deepEqual(kept, ["mpx/keep/t1/a"]);
  const branches = await git(root, ["branch", "--list", "mpx/keep/t1/a"]);
  assert.match((branches as { value: string }).value, /mpx\/keep\/t1\/a/);
  const worktrees = await git(root, ["worktree", "list"]);
  assert.doesNotMatch((worktrees as { value: string }).value, /keep/);
});

test("commits work in a repository with no configured identity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mpx-anon-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "a.txt"), "a\n");
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "user.name=x", "-c", "user.email=x@y.z", "commit", "-qm", "first"]);
  // Deliberately leave user.name/user.email unset for the repository itself.
  const repo = (await inspectRepo(dir)) as { ok: true; value: any };
  const trees = new Worktrees({ repo: repo.value, roomName: "anon", tag: "t1" });
  t.after(async () => await trees.close());
  const lane = (await trees.add("A")) as { ok: true; value: any };
  await writeFile(join(lane.value.cwd, "b.txt"), "b\n");
  const stat = await trees.commit(lane.value, "lane A");
  assert.equal(stat.ok, true, JSON.stringify(stat));
});

test("diffstat parsing survives git's singular and plural forms", () => {
  assert.deepEqual(parseShortstat(" 1 file changed, 1 insertion(+)"), {
    files: 1,
    insertions: 1,
    deletions: 0,
  });
  assert.deepEqual(parseShortstat(" 3 files changed, 42 insertions(+), 7 deletions(-)"), {
    files: 3,
    insertions: 42,
    deletions: 7,
  });
  assert.equal(renderStat({ files: 3, insertions: 42, deletions: 7 }), "3 files +42 -7");
  assert.equal(renderStat({ files: 0, insertions: 0, deletions: 0 }), "no changes");
});

/* ------------------------------------------------------------------ */
/* the command                                                         */
/* ------------------------------------------------------------------ */

test("/race takes an optional lane count and asks the room for the rest", () => {
  assert.deepEqual(parse("/race 4 add retries", ctx), {
    kind: "send",
    msg: { t: "propose", text: "add retries", race: 4 },
  });
  // No number means "however many this room uses", which the server resolves.
  assert.deepEqual(parse("/race add retries", ctx), {
    kind: "send",
    msg: { t: "propose", text: "add retries", race: 0 },
  });
  assert.equal(parse("/race 3", ctx).kind, "error");
  assert.equal(parse("/race", ctx).kind, "error");
  assert.deepEqual(parse("/lanes 2", ctx), { kind: "send", msg: { t: "setLanes", count: 2 } });
  assert.deepEqual(parse("/lanes", ctx), { kind: "local", action: "lanes" });
});

/* ------------------------------------------------------------------ */
/* end to end                                                          */
/* ------------------------------------------------------------------ */

interface Seat {
  conn: Connection;
  log: ServerMessage[];
  id: string;
}

async function startRoom(
  t: { after(fn: () => unknown): void },
  cwd: string,
  opts: {
    lanes?: number;
    preset?: string;
    mode?: (lane: string) => "write" | "nothing" | "fail";
    preview?: string;
    previewPort?: number;
  } = {},
) {
  const transport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "lanes" });
  const laneDir = await mkdtemp(join(tmpdir(), "mpx-lanedir-"));
  t.after(() => rm(laneDir, { recursive: true, force: true }));
  const server = new RoomServer({
    transport,
    roomName: "lanes",
    token: null,
    policy: resolvePreset(opts.preset ?? "solo")!,
    cwd,
    backend: "echo",
    model: "",
    maxTokens: 1000,
    showThinking: false,
    systemPromptExtra: "",
    backendBin: "",
    backendArgs: [],
    permissionMode: "acceptEdits",
    resume: null,
    attach: null,
    pool: false,
    lanes: opts.lanes ?? 3,
    laneSetup: null,
    lanePreview: opts.preview ?? null,
    lanePreviewPort: opts.previewPort ?? 56_000,
    laneDir,
    transcriptPath: null,
    backendFactory: ({ cwd: laneCwd, lane }) =>
      new Editor(laneCwd, lane ?? "-", lane ? (opts.mode?.(lane) ?? "write") : "nothing"),
  });
  await server.listen();
  t.after(async () => await server.close());
  return { server, port: transport.port };
}

function connect(port: number, name: string): Promise<Seat> {
  const conn = new Connection({
    url: `ws://127.0.0.1:${port}/r/lanes`,
    room: "lanes",
    token: null,
    name,
    observer: false,
    reconnect: false,
  });
  const log: ServerMessage[] = [];
  conn.on("message", (m: ServerMessage) => log.push(m));
  return new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} never got a welcome`)), 5000);
    conn.on("message", (m: ServerMessage) => {
      if (m.t === "welcome") {
        clearTimeout(timer);
        done({ conn, log, id: m.you.id });
      }
    });
    conn.on("closed", (why: string) => reject(new Error(`${name} closed: ${why}`)));
    conn.connect();
  });
}

function until(log: ServerMessage[], pred: (m: ServerMessage) => boolean, what: string, ms = 15000): Promise<ServerMessage> {
  const started = Date.now();
  return new Promise((done, reject) => {
    const tick = () => {
      const hit = log.find(pred);
      if (hit) return done(hit);
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function lanesOf(log: ServerMessage[]): LaneInfo[] {
  const last = [...log].reverse().find((m) => m.t === "lanes") as { lanes: LaneInfo[] } | undefined;
  return last?.lanes ?? [];
}

test("a race runs every lane in its own worktree, and the room lands one", async (t) => {
  const root = await scratchRepo(t);
  const { port } = await startRoom(t, root);
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "write the answer", race: 2 });
  await until(alice.log, (m) => m.t === "turnEnd" && m.stopReason === "lanes", "the lanes to finish");

  const lanes = lanesOf(alice.log);
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes.map((l) => l.id), ["A", "B"]);
  for (const lane of lanes) {
    assert.equal(lane.state, "done", `lane ${lane.id}: ${lane.error ?? ""}`);
    assert.match(lane.summary, /1 file/);
  }

  // Each lane is a real branch with a real commit, and they are different.
  const a = await git(root, ["show", "mpx/lanes/" + lanes[0]!.turnId + "/a:answer.txt"]);
  const b = await git(root, ["show", "mpx/lanes/" + lanes[0]!.turnId + "/b:answer.txt"]);
  assert.equal((a as { value: string }).value, "written by lane A");
  assert.equal((b as { value: string }).value, "written by lane B");

  // One proposal per lane, and approving one lands it.
  const props = alice.log.filter((m) => m.t === "proposal" && m.proposal.kind === "lane") as {
    proposal: { id: string; lane?: string };
  }[];
  assert.equal(props.length, 2);
  const b1 = props.find((p) => p.proposal.lane === "B")!;
  alice.conn.send({ t: "vote", proposalId: b1.proposal.id, vote: "yes" });

  await until(alice.log, (m) => m.t === "notice" && /lane B landed/.test(m.text), "the landing");
  assert.equal(await readFile(join(root, "answer.txt"), "utf8"), "written by lane B\n");

  // The lane nobody took is closed out, and its branch is still there to look at.
  await until(alice.log, (m) => m.t === "notice" && /lane branches kept/.test(m.text), "the branch list");
  const left = lanesOf(alice.log);
  assert.equal(left.find((l) => l.id === "B")!.state, "landed");
  assert.equal(left.find((l) => l.id === "A")!.state, "discarded");
  const worktrees = await git(root, ["worktree", "list"]);
  assert.doesNotMatch((worktrees as { value: string }).value, /mpx-lanedir/);
});

test("a race where nothing changed says so instead of opening an empty vote", async (t) => {
  const root = await scratchRepo(t);
  const { port } = await startRoom(t, root, { mode: () => "nothing" });
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "think about it", race: 2 });
  const notice = (await until(
    alice.log,
    (m) => m.t === "notice" && /no lane produced changes/.test(m.text),
    "the empty-race notice",
  )) as { text: string };
  assert.match(notice.text, /2 changed nothing/);
  assert.equal(
    alice.log.filter((m) => m.t === "proposal" && m.proposal.kind === "lane").length,
    0,
  );
});

test("one lane failing does not cost the room the others", async (t) => {
  const root = await scratchRepo(t);
  const { port } = await startRoom(t, root, { mode: (lane) => (lane === "A" ? "fail" : "write") });
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "try it", race: 2 });
  await until(alice.log, (m) => m.t === "turnEnd" && m.stopReason === "lanes", "the lanes to finish");

  const lanes = lanesOf(alice.log);
  assert.equal(lanes.find((l) => l.id === "A")!.state, "failed");
  assert.match(lanes.find((l) => l.id === "A")!.error!, /blew up/);
  assert.equal(lanes.find((l) => l.id === "B")!.state, "done");
  const props = alice.log.filter((m) => m.t === "proposal" && m.proposal.kind === "lane");
  assert.equal(props.length, 1);
});

test("voting every lane down lands nothing and cleans up", async (t) => {
  const root = await scratchRepo(t);
  const { port } = await startRoom(t, root);
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "write the answer", race: 2 });
  await until(alice.log, (m) => m.t === "turnEnd" && m.stopReason === "lanes", "the lanes to finish");

  const props = alice.log.filter((m) => m.t === "proposal" && m.proposal.kind === "lane") as {
    proposal: { id: string };
  }[];
  for (const p of props) alice.conn.send({ t: "vote", proposalId: p.proposal.id, vote: "no" });

  await until(alice.log, (m) => m.t === "notice" && m.text === "no lane landed", "the empty result");
  await assert.rejects(() => readFile(join(root, "answer.txt"), "utf8"));
});

test("a room outside a repository refuses to race, and says why", async (t) => {
  const plain = await mkdtemp(join(tmpdir(), "mpx-plain-room-"));
  t.after(() => rm(plain, { recursive: true, force: true }));
  const { port, server } = await startRoom(t, plain);
  assert.equal(server.canRace, false);

  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());
  alice.conn.send({ t: "propose", text: "write the answer", race: 2 });
  const e = (await until(alice.log, (m) => m.t === "error", "the refusal")) as { text: string };
  assert.match(e.text, /not a git repository/);
});

test("a race is never folded in with someone else's question", async (t) => {
  const root = await scratchRepo(t);
  const { port } = await startRoom(t, root, { preset: "solo" });
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  // `solo` merges queued prompts, which must not swallow the race.
  alice.conn.send({ t: "propose", text: "write the answer", race: 2 });
  alice.conn.send({ t: "propose", text: "and what about docs" });
  await until(alice.log, (m) => m.t === "turnEnd" && m.stopReason === "lanes", "the lanes to finish");

  const raceTurn = alice.log.find((m) => m.t === "turnStart") as { prompt: string };
  assert.doesNotMatch(raceTurn.prompt, /docs/);
});

/**
 * A preview command shaped like a real one: a shell line that starts a server
 * reading `$PORT`, serving the lane's own work out of the lane's own checkout.
 *
 * It answers with the file the lane wrote, which is what makes the assertion
 * below meaningful — the room is looking at *that lane's* running copy, not at
 * a server that merely happens to be up.
 */
const PREVIEW_CMD =
  `node -e "const{createServer}=require('node:http');` +
  `const{readFileSync}=require('node:fs');` +
  `createServer((q,s)=>s.end(readFileSync('answer.txt','utf8'))).listen(process.env.PORT,'127.0.0.1')"`;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  return (await res.text()).trim();
}

/** The latest lanes message that has an opinion about every lane's preview. */
function previewsOf(log: ServerMessage[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of lanesOf(log)) out[l.id] = l.preview?.state ?? "none";
  return out;
}

test("each lane comes up on its own port, serving its own work", async (t) => {
  const root = await scratchRepo(t);
  const { port } = await startRoom(t, root, { preview: PREVIEW_CMD, previewPort: 57_000 });
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "write the answer", race: 2 });
  await until(
    alice.log,
    (m) => m.t === "lanes" && m.lanes.length === 2 && m.lanes.every((l) => l.preview?.state === "ready"),
    "both previews to come up",
    40_000,
  );

  const lanes = lanesOf(alice.log);
  const a = lanes.find((l) => l.id === "A")!;
  const b = lanes.find((l) => l.id === "B")!;
  assert.notEqual(a.preview!.port, b.preview!.port, "two lanes never share a port");

  // The point of the whole feature: what is running is this lane's version.
  assert.equal(await fetchText(a.preview!.url!), "written by lane A");
  assert.equal(await fetchText(b.preview!.url!), "written by lane B");
});

test("landing a lane stops every preview and frees every port", async (t) => {
  const root = await scratchRepo(t);
  const { port } = await startRoom(t, root, { preview: PREVIEW_CMD, previewPort: 58_000 });
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "write the answer", race: 2 });
  await until(
    alice.log,
    (m) => m.t === "lanes" && m.lanes.length === 2 && m.lanes.every((l) => l.preview?.state === "ready"),
    "both previews to come up",
    40_000,
  );
  const ports = lanesOf(alice.log).map((l) => l.preview!.port!);

  const props = alice.log.filter((m) => m.t === "proposal" && m.proposal.kind === "lane") as {
    proposal: { id: string; lane?: string };
  }[];
  alice.conn.send({ t: "vote", proposalId: props.find((p) => p.proposal.lane === "A")!.proposal.id, vote: "yes" });
  await until(alice.log, (m) => m.t === "notice" && /lane branches kept/.test(m.text), "the race to end");

  // Nothing is left running: not the lane that lost, and not the one that won.
  for (const p of ports) assert.equal(await probe(p), false, `port ${p} is still held`);
  assert.deepEqual(previewsOf(alice.log), { A: "stopped", B: "stopped" });

  // And the checkouts really went away, which a live server in them would have
  // blocked. This is why previews are stopped before worktrees are removed.
  const worktrees = await git(root, ["worktree", "list"]);
  assert.doesNotMatch((worktrees as { value: string }).value, /mpx-lanedir/);
});

test("a preview that will not start leaves the lane votable on its diff", async (t) => {
  const root = await scratchRepo(t);
  const { port } = await startRoom(t, root, { preview: "exit 1", previewPort: 59_000, lanes: 2 });
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "write the answer", race: 2 });
  await until(
    alice.log,
    (m) => m.t === "lanes" && m.lanes.length === 2 && m.lanes.every((l) => l.preview?.state === "failed"),
    "both previews to give up",
    40_000,
  );

  // A dead preview is a shame, not a disqualification.
  for (const lane of lanesOf(alice.log)) {
    assert.equal(lane.state, "done", "the lane still finished");
    assert.match(lane.summary, /1 file/);
    assert.ok(lane.proposalId, "and the room can still vote on it");
  }
});
