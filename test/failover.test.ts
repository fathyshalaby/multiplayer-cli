import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport } from "../src/server/transport.js";
import { Connection } from "../src/client/connection.js";
import { LocalRunner } from "../src/client/runner.js";
import { resolvePreset } from "../src/core/policy.js";
import type { ClientMessage, ServerMessage } from "../src/protocol.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../src/agent/types.js";

/** A host backend that can be told to run out of capacity. */
class HostBackend implements AgentBackend {
  readonly name = "host-cli";
  readonly model = "host-1";
  calls: string[] = [];
  limitAfter = Infinity;
  async send(prompt: string, events: AgentEvents): Promise<TurnResult> {
    this.calls.push(prompt);
    if (this.calls.length > this.limitAfter) {
      return { stopReason: "error", error: "Claude usage limit reached. Your limit will reset at 3pm." };
    }
    events.onText("host answered");
    return { stopReason: "end_turn", usage: { output_tokens: 1 } };
  }
  async close(): Promise<void> {}
}

async function startRoom(pool = true) {
  const host = new HostBackend();
  const transport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "fo" });
  const server = new RoomServer({
    transport,
    roomName: "fo",
    token: null,
    policy: resolvePreset("solo")!, // no gate; this test is about execution
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
    pool,
    lanes: 0,
    laneSetup: null,
    transcriptPath: null,
    backendFactory: () => host,
  });
  await server.listen();
  return { server, host, port: transport.port };
}

interface Seat {
  conn: Connection;
  log: ServerMessage[];
}

function connect(port: number, name: string): Promise<Seat> {
  const conn = new Connection({ url: `ws://127.0.0.1:${port}/r/fo`, room: "fo", name, reconnect: false });
  const log: ServerMessage[] = [];
  conn.on("message", (m: ServerMessage) => log.push(m));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${name} never joined`)), 5000);
    conn.on("message", (m: ServerMessage) => {
      if (m.t === "welcome") {
        clearTimeout(timer);
        res({ conn, log });
      }
    });
    conn.connect();
  });
}

function until<T>(get: () => T | undefined | false | null, what: string, ms = 5000): Promise<T> {
  const started = Date.now();
  return new Promise((res, rej) => {
    const tick = () => {
      const v = get();
      if (v) return res(v as T);
      if (Date.now() - started > ms) return rej(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("when the host runs out, the turn moves to a teammate's subscription", async (t) => {
  const { server, host, port } = await startRoom();
  t.after(async () => await server.close());

  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");

  // Bob offers his own machine and account to the room.
  bob.conn.send({ t: "runner", backend: "codex", cwd: "/home/bob/repo" } as ClientMessage);
  await until(
    () => alice.log.find((m) => m.t === "runners" && (m as any).runners.length === 2),
    "the room seeing two accounts",
  );

  // First turn: the host has capacity, so nothing moves.
  alice.conn.send({ t: "propose", text: "first question" });
  await until(() => alice.log.find((m) => m.t === "turnEnd"), "the first turn");
  assert.equal(host.calls.length, 1);
  assert.equal(bob.log.filter((m) => m.t === "runTurn").length, 0, "bob was not disturbed");

  // Now the host is spent. The next turn should land on bob.
  host.limitAfter = 1;
  alice.conn.send({ t: "propose", text: "second question" });

  const run = (await until(() => bob.log.find((m) => m.t === "runTurn"), "the turn reaching bob")) as any;
  assert.match(run.prompt, /second question/);
  assert.match(run.prompt, /\[Session handoff\]/, "bob's tool is given the context it never had");
  assert.match(run.prompt, /first question/);

  // Bob's machine answers, and the whole room sees it.
  bob.conn.send({ t: "runOut", turnId: run.turnId, kind: "text", text: "bob's account answered" } as ClientMessage);
  bob.conn.send({ t: "runEnd", turnId: run.turnId, stopReason: "end_turn", usage: { output_tokens: 7 } } as ClientMessage);

  await until(() => alice.log.filter((m) => m.t === "turnEnd").length >= 2, "the second turn finishing");
  const text = alice.log.filter((m) => m.t === "delta").map((m) => (m as any).text).join("");
  assert.match(text, /bob's account answered/);

  // And the room can see whose account is carrying it now.
  const roster = [...alice.log].reverse().find((m) => m.t === "runners") as any;
  assert.equal(roster.activeId, roster.runners.find((r: any) => r.name === "bob").id);
  assert.equal(roster.runners.find((r: any) => r.local).exhausted, true);
  assert.ok(alice.log.some((m) => m.t === "notice" && /out of capacity/.test((m as any).text)));

  alice.conn.close();
  bob.conn.close();
});

test("a seat that leaves takes its account out of the pool", async (t) => {
  const { server, port } = await startRoom();
  t.after(async () => await server.close());

  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");
  bob.conn.send({ t: "runner", backend: "codex", cwd: "/home/bob" } as ClientMessage);
  await until(() => alice.log.find((m) => m.t === "runners" && (m as any).runners.length === 2), "two accounts");

  bob.conn.close();
  await until(
    () => {
      const last = [...alice.log].reverse().find((m) => m.t === "runners") as any;
      return last && last.runners.length === 1;
    },
    "the pool shrinking",
  );
  alice.conn.close();
});

test("observers cannot volunteer an account", async (t) => {
  const { server, port } = await startRoom();
  t.after(async () => await server.close());

  const alice = await connect(port, "alice");
  const conn = new Connection({ url: `ws://127.0.0.1:${port}/r/fo`, room: "fo", name: "dave", observer: true, reconnect: false });
  const log: ServerMessage[] = [];
  conn.on("message", (m: ServerMessage) => log.push(m));
  await new Promise<void>((r) => {
    conn.on("message", (m: ServerMessage) => m.t === "welcome" && r());
    conn.connect();
  });

  conn.send({ t: "runner", backend: "codex", cwd: "/x" } as ClientMessage);
  await until(() => log.find((m) => m.t === "error"), "the refusal");
  assert.match((log.find((m) => m.t === "error") as any).text, /observers cannot run/);
  conn.close();
  alice.conn.close();
});

test("a real seat runs a real turn on its own CLI", async (t) => {
  const { server, host, port } = await startRoom();
  t.after(async () => await server.close());

  // Bob's "codex" is a stub emitting the documented event stream.
  const dir = mkdtempSync(join(tmpdir(), "mpx-bobcli-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const out = [
  {type:"thread.started",thread_id:"th_bob"},
  {type:"item.completed",item:{id:"i1",type:"agent_message",text:"answered on bob's own subscription"}},
  {type:"turn.completed",usage:{input_tokens:3,output_tokens:5}},
];
for (const o of out) process.stdout.write(JSON.stringify(o)+"\\n");
`,
  );
  chmodSync(bin, 0o755);

  const alice = await connect(port, "alice");
  const bobConn = new Connection({ url: `ws://127.0.0.1:${port}/r/fo`, room: "fo", name: "bob", reconnect: false });
  const notices: string[] = [];
  const runner = new LocalRunner({
    connection: bobConn,
    backend: "codex",
    cwd: dir,
    model: "",
    maxTokens: 100,
    showThinking: false,
    backendBin: bin,
    backendArgs: [],
    permissionMode: "acceptEdits",
    resume: null,
    attach: null,
    onNotice: (t2) => notices.push(t2),
  });
  bobConn.on("message", (m: ServerMessage) => runner.handle(m));
  bobConn.on("open", () => runner.offer());
  await new Promise<void>((r) => {
    bobConn.on("message", (m: ServerMessage) => m.t === "welcome" && r());
    bobConn.connect();
  });
  t.after(async () => await runner.close());

  await until(() => alice.log.find((m) => m.t === "runners" && (m as any).runners.length === 2), "bob's CLI offered");

  host.limitAfter = 0; // the host has nothing left
  alice.conn.send({ t: "propose", text: "who is answering this?" });

  await until(() => alice.log.find((m) => m.t === "turnEnd"), "the turn finishing", 15000);
  const text = alice.log.filter((m) => m.t === "delta").map((m) => (m as any).text).join("");
  assert.match(text, /answered on bob's own subscription/);
  assert.equal(host.calls.length, 1, "the host tried once and was spent");
  assert.ok(notices.some((n) => /running this turn on your codex session/.test(n)));

  bobConn.close();
  alice.conn.close();
});


/* ---- the simple default ------------------------------------------ */

test("by default the room never leaves the host's account", async (t) => {
  const { server, host, port } = await startRoom(false);
  t.after(async () => await server.close());

  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");

  // Bob volunteers anyway. Pooling is off, so the room declines and says why.
  bob.conn.send({ t: "runner", backend: "codex", cwd: "/home/bob" } as ClientMessage);
  const refusal = (await until(() => bob.log.find((m) => m.t === "error"), "the refusal")) as any;
  assert.match(refusal.text, /runs every turn on the host's account/);
  assert.match(refusal.text, /--pool/, "and how to change it, if that is what they want");

  // No runner chatter reaches anyone: the simple room looks exactly as it did
  // before any of this existed.
  assert.equal(alice.log.filter((m) => m.t === "runners").length, 0);

  // And a spent host is simply a failed turn, not a search for someone to bill.
  host.limitAfter = 0;
  alice.conn.send({ t: "propose", text: "go" });
  const end = (await until(() => alice.log.find((m) => m.t === "turnEnd"), "the turn ending")) as any;
  assert.match(String(end.error), /usage limit/);
  assert.equal(bob.log.filter((m) => m.t === "runTurn").length, 0);
  assert.equal(host.calls.length, 1, "asked once, not once per seat");

  alice.conn.close();
  bob.conn.close();
});
