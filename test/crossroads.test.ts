import test from "node:test";
import assert from "node:assert/strict";
import { CrossroadsStream, extractCrossroads } from "../src/core/crossroads.js";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport } from "../src/server/transport.js";
import { Connection } from "../src/client/connection.js";
import { resolvePreset } from "../src/core/policy.js";
import { parse } from "../src/client/commands.js";
import type { CrossroadsInfo, ServerMessage } from "../src/protocol.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../src/agent/types.js";

const ctx = { defaultProposal: () => "#1" };

/* ------------------------------------------------------------------ */
/* the parser                                                          */
/* ------------------------------------------------------------------ */

const BLOCK = [
  "[[crossroads]]",
  "? Should v1 keep working?",
  "- Shim it — keep v1 behind an adapter",
  "- Migrate — break v1 and update every caller",
  "[[/crossroads]]",
].join("\n");

test("a block becomes a question and its options, and leaves the prose alone", () => {
  const { found, rest } = extractCrossroads(`Before.\n${BLOCK}\nAfter.`);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.question, "Should v1 keep working?");
  assert.deepEqual(found[0]!.options, [
    { label: "Shim it", detail: "keep v1 behind an adapter" },
    { label: "Migrate", detail: "break v1 and update every caller" },
  ]);
  // The block sat on its own line; removing it takes the line with it rather
  // than leaving a hole in the middle of the model's prose.
  assert.equal(rest, "Before.\nAfter.");
});

test("options may be bare, with any of the dashes a model actually types", () => {
  const { found } = extractCrossroads(
    ["[[crossroads]]", "? Which way?", "* Left: the short way", "- Right -- the safe way", "- Straight", "[[/crossroads]]"].join("\n"),
  );
  assert.deepEqual(found[0]!.options, [
    { label: "Left", detail: "the short way" },
    { label: "Right", detail: "the safe way" },
    { label: "Straight" },
  ]);
});

test("a malformed block is left in the transcript rather than swallowed", () => {
  // One option is not a fork, and eating the text would hide what was meant.
  const text = ["[[crossroads]]", "? Only one way?", "- Just this", "[[/crossroads]]"].join("\n");
  const { found, rest } = extractCrossroads(text);
  assert.equal(found.length, 0);
  assert.equal(rest, text);
});

test("an unterminated block is not a block", () => {
  const { found, rest } = extractCrossroads("[[crossroads]]\n? Never closed\n- a\n- b");
  assert.equal(found.length, 0);
  assert.match(rest, /Never closed/);
});

test("more than six options are trimmed rather than put to the room", () => {
  const many = ["[[crossroads]]", "? Too many?", ...Array.from({ length: 9 }, (_, i) => `- option ${i}`), "[[/crossroads]]"];
  const { found } = extractCrossroads(many.join("\n"));
  assert.equal(found[0]!.options.length, 6);
});

test("a streamed block is found across deltas, and the prose still arrives live", () => {
  const stream = new CrossroadsStream();
  const shown: string[] = [];
  let found = 0;
  // One character at a time is the worst case, and the one that actually happens.
  for (const ch of `Thinking. ${BLOCK} Done.`) {
    const step = stream.push(ch);
    shown.push(step.text);
    found += step.found.length;
  }
  shown.push(stream.flush());
  assert.equal(found, 1);
  assert.equal(shown.join(""), "Thinking.  Done.");
});

test("text that merely starts like a block is released once it cannot be one", () => {
  const stream = new CrossroadsStream();
  const out = [stream.push("see [[cross").text, stream.push("ed wires]]").text, stream.flush()].join("");
  assert.equal(out, "see [[crossed wires]]");
});

test("/ask needs a question and at least two options", () => {
  assert.deepEqual(parse("/ask keep v1? | shim | migrate", ctx), {
    kind: "send",
    msg: { t: "ask", question: "keep v1?", options: ["shim", "migrate"] },
  });
  assert.equal(parse("/ask keep v1? | shim", ctx).kind, "error");
  assert.equal(parse("/ask", ctx).kind, "error");
});

/* ------------------------------------------------------------------ */
/* end to end                                                          */
/* ------------------------------------------------------------------ */

/** Emits a crossroads block in its first turn, then records what it is told. */
class Forker implements AgentBackend {
  readonly name = "forker";
  readonly model = "forker-1";
  prompts: string[] = [];
  /** When set, asks through the blocking channel instead of the text stream. */
  blocking = false;
  answered: (string | null)[] = [];

  async send(prompt: string, events: AgentEvents): Promise<TurnResult> {
    this.prompts.push(prompt);
    if (this.blocking && events.onCrossroads) {
      const chosen = await events.onCrossroads("Should v1 keep working?", ["Shim it", "Migrate"]);
      this.answered.push(chosen);
      events.onText(`went with ${chosen ?? "my own judgement"}`);
      return { stopReason: "end_turn" };
    }
    if (this.prompts.length === 1) {
      events.onText(`Two ways.\n${BLOCK}\n`);
    } else {
      events.onText("carrying on");
    }
    return { stopReason: "end_turn" };
  }
  async close(): Promise<void> {}
}

interface Seat {
  conn: Connection;
  log: ServerMessage[];
  id: string;
}

async function startRoom(t: { after(fn: () => unknown): void }, preset = "solo") {
  const backend = new Forker();
  const transport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "fork" });
  const server = new RoomServer({
    transport,
    roomName: "fork",
    token: null,
    policy: resolvePreset(preset)!,
    cwd: process.cwd(),
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
    lanes: 0,
    laneSetup: null,
    transcriptPath: null,
    backendFactory: () => backend,
  });
  await server.listen();
  t.after(async () => await server.close());
  return { server, backend, port: transport.port };
}

function connect(port: number, name: string): Promise<Seat> {
  const conn = new Connection({
    url: `ws://127.0.0.1:${port}/r/fork`,
    room: "fork",
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

function until(log: ServerMessage[], pred: (m: ServerMessage) => boolean, what: string, ms = 8000): Promise<ServerMessage> {
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

function forkOf(log: ServerMessage[]): CrossroadsInfo | null {
  const last = [...log].reverse().find((m) => m.t === "crossroads") as { crossroads: CrossroadsInfo | null } | undefined;
  return last?.crossroads ?? null;
}

test("a fork in the model's output becomes a vote, and the block is not shown as prose", async (t) => {
  const { port } = await startRoom(t);
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "make v1 faster" });
  await until(alice.log, (m) => m.t === "crossroads", "the fork");

  const fork = forkOf(alice.log)!;
  assert.equal(fork.question, "Should v1 keep working?");
  assert.deepEqual(fork.options.map((o) => o.id), ["a", "b"]);
  assert.equal(fork.options[0]!.label, "Shim it");
  assert.equal(fork.blocking, false, "a backend that already streamed cannot be paused");

  // One proposal per option, so the choice reuses the ordinary voting system.
  const votes = alice.log.filter((m) => m.t === "proposal" && m.proposal.kind === "choice");
  assert.equal(votes.length, 2);

  // The machinery is not read out to the room as if it were an answer.
  const prose = alice.log.filter((m) => m.t === "delta").map((m) => (m as { text: string }).text).join("");
  assert.match(prose, /Two ways\./);
  assert.doesNotMatch(prose, /crossroads/);
});

test("choosing a direction closes the others and tells the model", async (t) => {
  const { port, backend } = await startRoom(t);
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "make v1 faster" });
  await until(alice.log, (m) => m.t === "crossroads", "the fork");
  const fork = forkOf(alice.log)!;

  const optionB = alice.log.find(
    (m) => m.t === "proposal" && m.proposal.kind === "choice" && m.proposal.option === "b",
  ) as { proposal: { id: string } };
  alice.conn.send({ t: "vote", proposalId: optionB.proposal.id, vote: "yes" });

  await until(alice.log, (m) => m.t === "crossroads" && m.crossroads?.state === "decided", "the decision");
  assert.equal(forkOf(alice.log)!.chosen, "b");

  // The losing option is closed rather than left on the table.
  const withdrawn = alice.log.find(
    (m) => m.t === "resolved" && m.proposal.kind === "choice" && m.proposal.option === "a",
  ) as { proposal: { status: string } };
  assert.equal(withdrawn.proposal.status, "withdrawn");

  // And the answer reaches the model, without the room voting a second time.
  await until(alice.log, (m) => m.t === "turnStart" && /The room decided: Migrate/.test(m.prompt), "the answer");
  assert.match(backend.prompts[1]!, /The room decided: Migrate\./);
  assert.equal(fork.id.startsWith("fork"), true);
});

test("voting every direction down is an answer too, and says so", async (t) => {
  const { port, backend } = await startRoom(t);
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "make v1 faster" });
  await until(alice.log, (m) => m.t === "crossroads", "the fork");

  for (const m of alice.log.filter((x) => x.t === "proposal" && x.proposal.kind === "choice") as {
    proposal: { id: string };
  }[]) {
    alice.conn.send({ t: "vote", proposalId: m.proposal.id, vote: "no" });
  }

  await until(alice.log, (m) => m.t === "crossroads" && m.crossroads?.state === "abandoned", "the abandonment");
  await until(alice.log, (m) => m.t === "turnStart" && /did not pick a direction/.test(m.prompt), "the answer");
  assert.match(backend.prompts[1]!, /Use your judgement/);
});

test("a backend that can be held waits for the room, and is told what it chose", async (t) => {
  const { port, backend } = await startRoom(t);
  backend.blocking = true;
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "propose", text: "make v1 faster" });
  await until(alice.log, (m) => m.t === "crossroads", "the fork");
  assert.equal(forkOf(alice.log)!.blocking, true);
  assert.equal(backend.answered.length, 0, "the turn is still waiting");

  const optionA = alice.log.find(
    (m) => m.t === "proposal" && m.proposal.kind === "choice" && m.proposal.option === "a",
  ) as { proposal: { id: string } };
  alice.conn.send({ t: "vote", proposalId: optionA.proposal.id, vote: "yes" });

  await until(alice.log, (m) => m.t === "turnEnd", "the turn finishing");
  assert.deepEqual(backend.answered, ["Shim it"]);
  // A held turn gets its answer directly; there is no follow-up message.
  assert.equal(backend.prompts.length, 1);
});

test("a person can put a fork to the room without the agent", async (t) => {
  const { port } = await startRoom(t);
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "ask", question: "ship on Friday?", options: ["yes, ship it", "no, wait for Monday"] });
  await until(alice.log, (m) => m.t === "crossroads", "the fork");
  const fork = forkOf(alice.log)!;
  assert.equal(fork.question, "ship on Friday?");
  assert.equal(fork.askedByName, "alice");
  assert.equal(fork.options.length, 2);
});

test("only one fork at a time, so the room is never asked two things at once", async (t) => {
  const { port } = await startRoom(t);
  const alice = await connect(port, "alice");
  t.after(() => alice.conn.close());

  alice.conn.send({ t: "ask", question: "first?", options: ["a", "b"] });
  await until(alice.log, (m) => m.t === "crossroads", "the first fork");
  alice.conn.send({ t: "ask", question: "second?", options: ["c", "d"] });
  const e = (await until(alice.log, (m) => m.t === "error", "the refusal")) as { text: string };
  assert.match(e.text, /already deciding one fork/);
});
