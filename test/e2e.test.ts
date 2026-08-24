import test from "node:test";
import assert from "node:assert/strict";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport } from "../src/server/transport.js";
import { Connection } from "../src/client/connection.js";
import { resolvePreset } from "../src/core/policy.js";
import type { ServerMessage } from "../src/protocol.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../src/agent/types.js";

/** A backend that records what it was asked and answers deterministically. */
class ScriptedBackend implements AgentBackend {
  readonly name = "scripted";
  readonly model = "scripted-1";
  prompts: string[] = [];
  /** When set, every turn asks the room for permission to run this tool. */
  wantsTool: { name: string; risk: "read" | "write" | "exec" } | null = null;
  toolDecisions: { allow: boolean; reason: string }[] = [];
  /** Holds every turn open until `release()` is called, so tests can act mid-turn. */
  private held: Promise<void> | null = null;
  private releaseHeld: (() => void) | null = null;

  hold(): void {
    this.held = new Promise<void>((r) => {
      this.releaseHeld = r;
    });
  }
  release(): void {
    this.releaseHeld?.();
    this.held = null;
    this.releaseHeld = null;
  }

  async send(prompt: string, events: AgentEvents, signal: AbortSignal): Promise<TurnResult> {
    this.prompts.push(prompt);
    events.onText("ack: ");
    events.onText(prompt.slice(0, 20));
    if (this.wantsTool) {
      const d = await events.onToolRequest({
        toolUseId: `tu_${this.prompts.length}`,
        name: this.wantsTool.name,
        input: { command: "echo hi" },
        risk: this.wantsTool.risk,
        summary: `${this.wantsTool.name}: echo hi`,
      });
      this.toolDecisions.push(d);
      events.onToolResult(`tu_${this.prompts.length}`, d.allow, d.allow ? "hi" : d.reason);
    }
    if (this.held) {
      await Promise.race([
        this.held,
        new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })),
      ]);
    }
    if (signal.aborted) return { stopReason: "interrupted" };
    return { stopReason: "end_turn", usage: { output_tokens: 4 } };
  }
  async close(): Promise<void> {}
}

interface Seat {
  conn: Connection;
  log: ServerMessage[];
  id: string;
  name: string;
}

async function startRoom(preset: string, opts: Partial<{ token: string | null }> = {}) {
  const backend = new ScriptedBackend();
  const transport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "e2e" });
  const server = new RoomServer({
    transport,
    roomName: "e2e",
    token: opts.token === undefined ? null : opts.token,
    policy: resolvePreset(preset)!,
    cwd: process.cwd(),
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
    transcriptPath: null,
    backendFactory: () => backend,
  });
  await server.listen();
  return { server, backend, port: transport.port };
}

function connect(port: number, name: string, token?: string, observer = false): Promise<Seat> {
  const conn = new Connection({
    url: `ws://127.0.0.1:${port}/${token ? `?t=${token}` : ""}`,
    name,
    observer,
    reconnect: false,
  });
  const log: ServerMessage[] = [];
  conn.on("message", (m: ServerMessage) => log.push(m));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} never got a welcome`)), 5000);
    conn.on("message", (m: ServerMessage) => {
      if (m.t === "welcome") {
        clearTimeout(timer);
        resolvePromise({ conn, log, id: m.you.id, name: m.you.name });
      }
    });
    conn.on("closed", (why: string) => {
      clearTimeout(timer);
      reject(new Error(`${name} closed: ${why}`));
    });
    conn.connect();
  });
}

/** Wait until `pred` sees the message it wants, or fail loudly. */
function until(log: ServerMessage[], pred: (m: ServerMessage) => boolean, what: string, ms = 4000): Promise<ServerMessage> {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const tick = () => {
      const hit = log.find(pred);
      if (hit) return resolvePromise(hit);
      if (Date.now() - started > ms) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("two people, one shared session: a prompt only ships once both agree", async (t) => {
  const { server, backend, port } = await startRoom("pair");
  t.after(async () => await server.close());

  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");
  await until(alice.log, (m) => m.t === "presence" && m.joined === "bob", "bob joining");

  alice.conn.send({ t: "propose", text: "add retries to the http client" });
  const created = (await until(bob.log, (m) => m.t === "proposal" && m.event === "new", "bob seeing the proposal")) as Extract<ServerMessage, { t: "proposal" }>;

  assert.equal(created.proposal.authorName, "alice");
  assert.equal(backend.prompts.length, 0, "nothing reaches the model before consent");

  bob.conn.send({ t: "vote", proposalId: created.proposal.id, vote: "yes" });
  await until(alice.log, (m) => m.t === "turnStart", "the turn starting");

  assert.equal(backend.prompts.length, 1);
  assert.match(backend.prompts[0]!, /add retries to the http client/);
  assert.match(backend.prompts[0]!, /\[alice/, "the model is told who asked");

  // Both seats receive the same stream.
  await until(alice.log, (m) => m.t === "turnEnd", "alice seeing the turn end");
  await until(bob.log, (m) => m.t === "turnEnd", "bob seeing the turn end");
  const aliceText = alice.log.filter((m) => m.t === "delta").map((m) => (m as any).text).join("");
  const bobText = bob.log.filter((m) => m.t === "delta").map((m) => (m as any).text).join("");
  assert.equal(aliceText, bobText, "everyone sees identical output");
  assert.match(aliceText, /^ack: /);

  alice.conn.close();
  bob.conn.close();
});

test("a veto keeps the prompt away from the model entirely", async (t) => {
  const { server, backend, port } = await startRoom("pair");
  t.after(async () => await server.close());
  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");
  await until(alice.log, (m) => m.t === "presence" && m.joined === "bob", "bob joining");

  alice.conn.send({ t: "propose", text: "wipe the staging database" });
  const created = (await until(bob.log, (m) => m.t === "proposal" && m.event === "new", "the proposal")) as any;
  bob.conn.send({ t: "vote", proposalId: created.proposal.id, vote: "no", comment: "absolutely not" });

  const resolved = (await until(alice.log, (m) => m.t === "resolved", "the rejection")) as any;
  assert.equal(resolved.proposal.status, "rejected");
  assert.match(resolved.proposal.resolution, /absolutely not/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(backend.prompts.length, 0);

  alice.conn.close();
  bob.conn.close();
});

test("the room votes on the model's tool calls, and a denial reaches the model", async (t) => {
  const { server, backend, port } = await startRoom("pair");
  t.after(async () => await server.close());
  backend.wantsTool = { name: "bash", risk: "exec" };

  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");
  await until(alice.log, (m) => m.t === "presence" && m.joined === "bob", "bob joining");

  alice.conn.send({ t: "propose", text: "check the disk usage" });
  const prompt = (await until(bob.log, (m) => m.t === "proposal" && m.event === "new", "the prompt vote")) as any;
  bob.conn.send({ t: "vote", proposalId: prompt.proposal.id, vote: "yes" });

  // The turn now blocks on a *tool* vote, which is the whole point.
  const toolVote = (await until(
    alice.log,
    (m) => m.t === "proposal" && m.event === "new" && m.proposal.kind === "tool",
    "the tool vote",
  )) as any;
  assert.match(toolVote.proposal.text, /bash: echo hi/);
  assert.equal(backend.toolDecisions.length, 0, "the turn is genuinely waiting");

  bob.conn.send({ t: "vote", proposalId: toolVote.proposal.id, vote: "no", comment: "not on prod" });
  await until(alice.log, (m) => m.t === "turnEnd", "the turn finishing");
  assert.equal(backend.toolDecisions.length, 1);
  assert.equal(backend.toolDecisions[0]!.allow, false);
  assert.match(backend.toolDecisions[0]!.reason, /not on prod/);

  alice.conn.close();
  bob.conn.close();
});

test("read-only tools are auto-allowed without interrupting anyone", async (t) => {
  const { server, backend, port } = await startRoom("pair");
  t.after(async () => await server.close());
  backend.wantsTool = { name: "read_file", risk: "read" };

  const alice = await connect(port, "alice");
  alice.conn.send({ t: "propose", text: "read the config" });
  await until(alice.log, (m) => m.t === "turnEnd", "the turn finishing");

  assert.equal(backend.toolDecisions.length, 1);
  assert.equal(backend.toolDecisions[0]!.allow, true);
  const toolVotes = alice.log.filter((m) => m.t === "proposal" && (m as any).proposal.kind === "tool");
  assert.equal(toolVotes.length, 0, "nobody was asked about a read");

  alice.conn.close();
});

test("prompts approved while the model is busy are merged into the next turn", async (t) => {
  const { server, backend, port } = await startRoom("solo");
  t.after(async () => await server.close());
  const alice = await connect(port, "alice");
  backend.hold();

  alice.conn.send({ t: "propose", text: "first thing" });
  await until(alice.log, (m) => m.t === "turnStart", "the first turn");
  // The model is busy. Both of these queue behind it rather than racing in.
  alice.conn.send({ t: "propose", text: "second thing" });
  alice.conn.send({ t: "propose", text: "third thing" });
  await until(alice.log, (m) => m.t === "queued" && (m as any).proposalIds.length === 2, "both queueing");
  backend.release();

  await until(
    alice.log,
    (m) => m.t === "turnEnd" && alice.log.filter((x) => x.t === "turnEnd").length >= 2,
    "the second turn finishing",
  );
  assert.equal(backend.prompts.length, 2, "three proposals, two turns");
  assert.match(backend.prompts[1]!, /second thing/);
  assert.match(backend.prompts[1]!, /third thing/);

  alice.conn.close();
});

test("an observer sees the session but cannot steer it", async (t) => {
  const { server, backend, port } = await startRoom("pair");
  t.after(async () => await server.close());
  const alice = await connect(port, "alice");
  const dave = await connect(port, "dave", undefined, true);
  await until(alice.log, (m) => m.t === "presence" && m.joined === "dave", "dave joining");

  dave.conn.send({ t: "propose", text: "let me drive" });
  await until(dave.log, (m) => m.t === "error", "the refusal");
  assert.equal(backend.prompts.length, 0);

  // But a real proposal still streams to their screen.
  alice.conn.send({ t: "propose", text: "carry on" });
  await until(dave.log, (m) => m.t === "delta", "dave seeing the output");

  alice.conn.close();
  dave.conn.close();
});

test("anyone may interrupt when the policy says so", async (t) => {
  const { server, backend, port } = await startRoom("pair");
  t.after(async () => await server.close());
  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");
  await until(alice.log, (m) => m.t === "presence" && m.joined === "bob", "bob joining");

  backend.hold();
  alice.conn.send({ t: "propose", text: "long running thing" });
  const p = (await until(bob.log, (m) => m.t === "proposal" && m.event === "new", "the proposal")) as any;
  bob.conn.send({ t: "vote", proposalId: p.proposal.id, vote: "yes" });
  await until(alice.log, (m) => m.t === "turnStart", "the turn starting");
  bob.conn.send({ t: "interrupt" });

  const notice = (await until(alice.log, (m) => m.t === "notice" && /interrupted/.test(m.text), "the interrupt notice")) as any;
  assert.match(notice.text, /bob/);
  const end = (await until(alice.log, (m) => m.t === "turnEnd", "the turn ending")) as any;
  assert.equal(end.stopReason, "interrupted");

  alice.conn.close();
  bob.conn.close();
});

test("a wrong join token is refused", async (t) => {
  const { server, port } = await startRoom("pair", { token: "the-real-token" });
  t.after(async () => await server.close());
  await assert.rejects(
    () => connect(port, "mallory", "guessing"),
    /unauthorized|closed/,
  );
  const ok = await connect(port, "alice", "the-real-token");
  assert.equal(ok.name, "alice");
  ok.conn.close();
});

test("side chat never reaches the model", async (t) => {
  const { server, backend, port } = await startRoom("pair");
  t.after(async () => await server.close());
  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");
  await until(alice.log, (m) => m.t === "presence" && m.joined === "bob", "bob joining");

  alice.conn.send({ t: "chat", text: "should we even ask it this?" });
  const chat = (await until(bob.log, (m) => m.t === "chat", "the chat message")) as any;
  assert.equal(chat.text, "should we even ask it this?");
  assert.equal(chat.fromName, "alice");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(backend.prompts.length, 0);

  alice.conn.close();
  bob.conn.close();
});

test("the host can retune the policy mid-session", async (t) => {
  const { server, backend, port } = await startRoom("strict");
  t.after(async () => await server.close());
  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");
  await until(alice.log, (m) => m.t === "presence" && m.joined === "bob", "bob joining");

  bob.conn.send({ t: "setPolicy", patch: { preset: "solo" } });
  await until(bob.log, (m) => m.t === "error" && /only the host/.test(m.text), "bob being refused");

  alice.conn.send({ t: "setPolicy", patch: { preset: "team", overrides: ["timeout=off"] } });
  const applied = (await until(bob.log, (m) => m.t === "policy", "the new policy")) as any;
  assert.equal(applied.policy.prompt.mode, "majority");
  assert.equal(applied.policy.prompt.autoApproveMs, null);
  assert.equal(backend.prompts.length, 0);

  alice.conn.close();
  bob.conn.close();
});

test("a bad policy override is rejected without changing anything", async (t) => {
  const { server, port } = await startRoom("team");
  t.after(async () => await server.close());
  const alice = await connect(port, "alice");
  alice.conn.send({ t: "setPolicy", patch: { overrides: ["mode=anarchy"] } });
  const e = (await until(alice.log, (m) => m.t === "error", "the complaint")) as any;
  assert.match(e.text, /mode must be one of/);
  alice.conn.close();
});

test("lazy consensus ships the prompt when nobody objects in time", async (t) => {
  const backend = new ScriptedBackend();
  const policy = resolvePreset("pair")!;
  policy.prompt.autoApproveMs = 150; // a timer short enough for a test
  const timerTransport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "timer" });
  const server = new RoomServer({
    transport: timerTransport, roomName: "timer", token: null, policy,
    cwd: process.cwd(), backend: "echo", model: "", maxTokens: 100,
    showThinking: false, systemPromptExtra: "", backendBin: "", backendArgs: [],
    permissionMode: "acceptEdits", resume: null, attach: null, transcriptPath: null,
    backendFactory: () => backend,
  });
  await server.listen();
  const port = timerTransport.port;
  t.after(async () => await server.close());

  const alice = await connect(port, "alice");
  const bob = await connect(port, "bob");
  await until(alice.log, (m) => m.t === "presence" && m.joined === "bob", "bob joining");

  alice.conn.send({ t: "propose", text: "silence means yes" });
  const resolved = (await until(alice.log, (m) => m.t === "resolved", "the timer firing")) as any;
  assert.equal(resolved.proposal.status, "approved");
  assert.match(resolved.proposal.resolution, /timer/);
  assert.equal(backend.prompts.length, 1);

  alice.conn.close();
  bob.conn.close();
});
