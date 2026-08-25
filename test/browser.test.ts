import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay } from "../src/server/relay.js";
import { RoomServer } from "../src/server/server.js";
import { RelayTransport } from "../src/server/transport.js";
import { Connection } from "../src/client/connection.js";
import { resolvePreset } from "../src/core/policy.js";
import type { ServerMessage } from "../src/protocol.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../src/agent/types.js";
import { git, inspectRepo } from "../src/core/worktree.js";

/**
 * Drives the browser seat in a real Chromium, because the whole promise of the
 * share link is that clicking it works — and that is the one claim the
 * protocol tests cannot make.
 *
 * Skipped when neither Playwright nor a browser is available, so `npm test`
 * stays a plain `npm install` away for everyone else.
 */
const CHROME_CANDIDATES = [
  process.env.MPX_CHROME,
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  "/opt/pw-browsers/chromium/chrome-linux/chrome",
].filter(Boolean) as string[];

async function browser() {
  let chromium: any;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return null;
  }
  const explicit = CHROME_CANDIDATES.find((p) => existsSync(p));
  try {
    return await chromium.launch(explicit ? { executablePath: explicit } : {});
  } catch {
    return null;
  }
}

class Recorder implements AgentBackend {
  readonly name = "recorder";
  readonly model = "rec-1";
  prompts: string[] = [];
  async send(prompt: string, events: AgentEvents): Promise<TurnResult> {
    this.prompts.push(prompt);
    events.onText("the room asked: " + prompt.slice(0, 40));
    return { stopReason: "end_turn" };
  }
  async close(): Promise<void> {}
}

/** A backend that edits its own worktree, so a race produces real diffs. */
class LaneEditor implements AgentBackend {
  readonly name = "lane-editor";
  readonly model = "lane-1";
  constructor(private cwd: string, private lane: string) {}
  async send(_prompt: string, events: AgentEvents): Promise<TurnResult> {
    events.onText(`lane ${this.lane}`);
    await writeFile(join(this.cwd, "answer.txt"), `from ${this.lane}\n`);
    return { stopReason: "end_turn" };
  }
  async close(): Promise<void> {}
}

async function scene(opts: { cwd?: string; lanes?: number } = {}) {
  const relay = new Relay({ host: "127.0.0.1", port: 0, maxRooms: 4, maxPeersPerRoom: 8, joinsPerMinute: 60, directory: false });
  const port = await relay.listen();
  const backend = new Recorder();
  const transport = new RelayTransport({ url: `ws://127.0.0.1:${port}`, roomName: "clickable" });
  const server = new RoomServer({
    transport,
    roomName: "clickable",
    token: "sekrit",
    policy: resolvePreset("pair")!,
    cwd: opts.cwd ?? process.cwd(),
    backend: "echo",
    model: "",
    maxTokens: 100,
    showThinking: false,
    systemPromptExtra: "",
    backendBin: "",
    backendArgs: [],
    permissionMode: "acceptEdits",
    resume: null,
    attach: null,
    pool: false,
    lanes: opts.lanes ?? 0,
    laneSetup: null,
    transcriptPath: null,
    backendFactory: ({ cwd, lane }) => (lane ? new LaneEditor(cwd, lane) : backend),
  });
  const info = await server.listen();
  return { relay, server, backend, share: info.shareUrl("sekrit")!, ws: info.joinUrl("sekrit") };
}

function terminalSeat(url: string, name: string) {
  const conn = new Connection({ url, room: "clickable", token: "sekrit", name, reconnect: false });
  const log: ServerMessage[] = [];
  conn.on("message", (m: ServerMessage) => log.push(m));
  return new Promise<{ conn: Connection; log: ServerMessage[] }>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("no welcome")), 5000);
    conn.on("message", (m: ServerMessage) => {
      if (m.t === "welcome") {
        clearTimeout(timer);
        res({ conn, log });
      }
    });
    conn.connect();
  });
}

/**
 * Poll until the predicate is happy.
 *
 * `get` is awaited: half the checks here have to ask the page something, and a
 * pending promise is truthy, so a version that did not await would resolve on
 * the first tick with whatever the promise was — including `false`.
 */
function until<T>(get: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 8000): Promise<T> {
  const started = Date.now();
  return new Promise((res, rej) => {
    const tick = async () => {
      let v: T | undefined | false;
      try {
        v = await get();
      } catch (err) {
        return rej(err);
      }
      if (v) return res(v as T);
      if (Date.now() - started > ms) return rej(new Error(`timed out waiting for ${what}`));
      setTimeout(() => void tick(), 25);
    };
    void tick();
  });
}

test("clicking the shared link gets you a working seat", async (t) => {
  const b = await browser();
  if (!b) {
    t.skip("no browser available");
    return;
  }
  const { relay, server, backend, share, ws } = await scene();
  t.after(async () => {
    await b.close();
    await server.close();
    await relay.close();
  });

  const page = await b.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(share);

  // The landing page tells a terminal user exactly what to run: the share link
  // itself, so the token stays in the fragment rather than moving to a query.
  const cmd = String(await page.textContent("#cmd"));
  assert.match(cmd, /^npx multiplayer-cli join http:\/\/127\.0\.0\.1:\d+\/s\/clickable#t=sekrit$/);
  assert.ok(!cmd.includes("?t="), "never as a query parameter");

  // And offers a seat right there.
  await page.fill("#gate-name", "dana");
  await page.click("#enter");
  await page.waitForSelector("#foot:not([hidden])", { timeout: 8000 });
  assert.match(String(await page.textContent("#room")), /clickable/);
  assert.match(String(await page.textContent("#roster")), /dana/);

  // A terminal seat joins the same room. Dana is already there, so she arrives
  // in the welcome snapshot rather than as a later presence update.
  const alice = await terminalSeat(ws, "alice");
  const welcome = alice.log.find((m) => m.t === "welcome") as any;
  assert.ok(
    welcome.room.participants.some((p: any) => p.name === "dana"),
    "the browser seat is a full participant, not a spectator",
  );

  // The browser proposes; the terminal sees it and it is NOT sent yet.
  await page.fill("#input", "can a browser seat propose?");
  await page.click("#send");
  const proposal = (await until(
    () => alice.log.find((m) => m.t === "proposal" && (m as any).event === "new"),
    "the proposal reaching the terminal",
  )) as any;
  assert.equal(proposal.proposal.authorName, "dana");
  assert.equal(backend.prompts.length, 0, "consent still gates the model");

  // The terminal approves; the browser sees the reply stream in.
  alice.conn.send({ t: "vote", proposalId: proposal.proposal.id, vote: "yes" });
  await until(async () => (await page.textContent("#log"))?.includes("the room asked:"), "the reply on the page");
  assert.equal(backend.prompts.length, 1);
  assert.match(backend.prompts[0]!, /can a browser seat propose\?/);
  assert.match(backend.prompts[0]!, /\[dana/, "the model is told who asked");

  assert.deepEqual(errors, [], "the page threw nothing");
  alice.conn.close();
});

test("a browser seat with the wrong link never gets into the room", async (t) => {
  const b = await browser();
  if (!b) {
    t.skip("no browser available");
    return;
  }
  const { relay, server, backend, share } = await scene();
  t.after(async () => {
    await b.close();
    await server.close();
    await relay.close();
  });

  const page = await b.newPage();
  await page.goto(share.replace("#t=sekrit", "#t=not-the-token"));
  await page.fill("#gate-name", "mallory");
  await page.click("#enter");
  await until(async () => (await page.textContent("#gate-err"))?.match(/refused|authenticate/), "the refusal");
  assert.equal(server.room.list().length, 0, "never a participant");
  assert.equal(backend.prompts.length, 0);
});

test("the browser can veto, with a reason that is recorded", async (t) => {
  const b = await browser();
  if (!b) {
    t.skip("no browser available");
    return;
  }
  const { relay, server, backend, share, ws } = await scene();
  t.after(async () => {
    await b.close();
    await server.close();
    await relay.close();
  });

  const page = await b.newPage();
  page.on("dialog", (d: any) => d.accept("not on a shared machine"));
  await page.goto(share);
  await page.fill("#gate-name", "dana");
  await page.click("#enter");
  await page.waitForSelector("#foot:not([hidden])", { timeout: 8000 });

  const alice = await terminalSeat(ws, "alice");
  alice.conn.send({ t: "propose", text: "rm -rf the build directory" });

  await page.waitForSelector(".card button.no", { timeout: 8000 });
  await page.click(".card button.no");

  const resolved = (await until(() => alice.log.find((m) => m.t === "resolved"), "the veto")) as any;
  assert.equal(resolved.proposal.status, "rejected");
  assert.match(resolved.proposal.resolution, /not on a shared machine/);
  assert.equal(backend.prompts.length, 0);
  alice.conn.close();
});

test("a bad token is refused in the browser too", async (t) => {
  const b = await browser();
  if (!b) {
    t.skip("no browser available");
    return;
  }
  const { relay, server, share } = await scene();
  t.after(async () => {
    await b.close();
    await server.close();
    await relay.close();
  });

  const page = await b.newPage();
  await page.goto(share.replace("#t=sekrit", "#t=wrong"));
  await page.fill("#gate-name", "mallory");
  await page.click("#enter");
  await until(async () => (await page.textContent("#gate-err"))?.includes("refused"), "the refusal");
  assert.ok(await page.isVisible("#gate"), "they never get past the door");
});

test("the browser seat can start a race and vote on the diffs", async (t) => {
  const b = await browser();
  if (!b) {
    t.skip("no browser available");
    return;
  }
  const repo = await mkdtemp(join(tmpdir(), "mpx-browser-repo-"));
  await git(repo, ["init", "-q", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@e.st"]);
  await git(repo, ["config", "user.name", "t"]);
  await writeFile(join(repo, "README.md"), "# scratch\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-qm", "first"]);

  const { relay, server, share, ws } = await scene({ cwd: repo, lanes: 2 });
  t.after(async () => {
    await b.close();
    await server.close();
    await relay.close();
    await rm(repo, { recursive: true, force: true });
  });
  assert.equal(server.canRace, true);

  const page = await b.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.goto(share);
  await page.fill("#gate-name", "dana");
  await page.click("#enter");
  await page.waitForSelector("#foot:not([hidden])", { timeout: 8000 });

  // Two seats, so `pair` needs both to agree before two agents start work.
  const alice = await terminalSeat(ws, "alice");
  await page.fill("#input", "/race 2 write the answer");
  await page.click("#send");
  const proposal = (await until(
    () => alice.log.find((m) => m.t === "proposal" && (m as any).event === "new"),
    "the race proposal",
  )) as any;
  assert.equal(proposal.proposal.race, 2, "the room is told this is a race");
  alice.conn.send({ t: "vote", proposalId: proposal.proposal.id, vote: "yes" });

  // The page draws a live lane list rather than interleaving two agents' output.
  await until(async () => (await page.textContent("#log"))?.includes("1 file"), "the lane list");
  const laneText = String(await page.textContent(".lanes"));
  assert.match(laneText, /A/);
  assert.match(laneText, /B/);
  assert.ok(!laneText.includes("lane A"), "lane chatter stays out of the transcript");

  // One card per lane, each carrying the diffstat the room is voting on.
  const cards = await until(async () => {
    const n = await page.$$eval(".card.lane", (els: unknown[]) => els.length);
    return n === 2 ? n : false;
  }, "a card per lane");
  assert.equal(cards, 2);
  assert.match(String(await page.textContent(".card.lane .diff")), /answer\.txt/);

  // `pair` needs both seats to agree on the *same* lane, so the browser and the
  // terminal each approve B — which is exactly the decision racing exists for.
  const landing = alice.log.filter((m) => m.t === "proposal" && (m as any).proposal.kind === "lane") as any[];
  const laneB = landing.find((m) => m.proposal.lane === "B")!;
  await page.click('.card.lane[data-lane="B"] button.yes');
  alice.conn.send({ t: "vote", proposalId: laneB.proposal.id, vote: "yes" });
  await until(
    () => alice.log.find((m) => m.t === "notice" && /lane B landed/.test((m as any).text)),
    "the landing notice",
  );
  const log = await git(repo, ["log", "--oneline", "-1"]);
  assert.match((log as { value: string }).value, /Land lane B/);
  assert.equal(await readFile(join(repo, "answer.txt"), "utf8"), "from B\n");

  assert.deepEqual(errors, [], "the page threw nothing");
  alice.conn.close();
});
