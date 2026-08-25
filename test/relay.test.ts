import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { Relay } from "../src/server/relay.js";
import { RoomServer } from "../src/server/server.js";
import { RelayTransport } from "../src/server/transport.js";
import { Connection } from "../src/client/connection.js";
import { resolvePreset } from "../src/core/policy.js";
import type { ServerMessage } from "../src/protocol.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../src/agent/types.js";

class TinyBackend implements AgentBackend {
  readonly name = "tiny";
  readonly model = "tiny-1";
  prompts: string[] = [];
  async send(prompt: string, events: AgentEvents): Promise<TurnResult> {
    this.prompts.push(prompt);
    events.onText("relayed: " + prompt.slice(0, 24));
    return { stopReason: "end_turn", usage: { output_tokens: 1 } };
  }
  async close(): Promise<void> {}
}

async function startRelay(opts: Partial<{ maxRooms: number; maxPeers: number; joinsPerMinute: number }> = {}) {
  const relay = new Relay({
    host: "127.0.0.1",
    port: 0,
    maxRooms: opts.maxRooms ?? 8,
    maxPeersPerRoom: opts.maxPeers ?? 8,
    joinsPerMinute: opts.joinsPerMinute ?? 60,
  });
  const port = await relay.listen();
  return { relay, port, url: `ws://127.0.0.1:${port}` };
}

async function startRoom(relayUrl: string, roomName: string, token: string | null) {
  const backend = new TinyBackend();
  const transport = new RelayTransport({ url: relayUrl, roomName });
  const server = new RoomServer({
    transport,
    roomName,
    token,
    policy: resolvePreset("pair")!,
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
    transcriptPath: null,
    backendFactory: () => backend,
  });
  const info = await server.listen();
  return { server, backend, joinUrl: info.joinUrl(token) };
}

interface Seat {
  conn: Connection;
  log: ServerMessage[];
  name: string;
}

function connect(url: string, name: string): Promise<Seat> {
  const conn = new Connection({ url, name, reconnect: false });
  const log: ServerMessage[] = [];
  conn.on("message", (m: ServerMessage) => log.push(m));
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} never got a welcome`)), 5000);
    conn.on("message", (m: ServerMessage) => {
      if (m.t === "welcome") {
        clearTimeout(timer);
        resolvePromise({ conn, log, name: m.you.name });
      }
      if (m.t === "error") {
        clearTimeout(timer);
        reject(new Error(m.text));
      }
    });
    conn.on("closed", (why: string) => {
      clearTimeout(timer);
      reject(new Error(`closed: ${why}`));
    });
    conn.connect();
  });
}

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

test("a full session works through the relay, with no inbound port on the host", async (t) => {
  const { relay, url } = await startRelay();
  const { server, backend, joinUrl } = await startRoom(url, "relayed", "tok-abcdef");
  t.after(async () => {
    await server.close();
    await relay.close();
  });

  assert.match(joinUrl, /^ws:\/\/127\.0\.0\.1:\d+\/r\/relayed\?t=tok-abcdef$/, "the invite points at the relay");
  assert.equal(relay.roomCount, 1);

  const alice = await connect(joinUrl, "alice");
  const bob = await connect(joinUrl, "bob");
  await until(alice.log, (m) => m.t === "presence" && m.joined === "bob", "bob joining");

  alice.conn.send({ t: "propose", text: "does the relay carry a vote" });
  const proposal = (await until(bob.log, (m) => m.t === "proposal" && m.event === "new", "bob seeing it")) as any;
  assert.equal(backend.prompts.length, 0, "consent still gates the model");

  bob.conn.send({ t: "vote", proposalId: proposal.proposal.id, vote: "yes" });
  await until(alice.log, (m) => m.t === "turnEnd", "the turn finishing");
  await until(bob.log, (m) => m.t === "turnEnd", "bob seeing it too");

  assert.equal(backend.prompts.length, 1);
  const aliceText = alice.log.filter((m) => m.t === "delta").map((m) => (m as any).text).join("");
  const bobText = bob.log.filter((m) => m.t === "delta").map((m) => (m as any).text).join("");
  assert.equal(aliceText, bobText);
  assert.match(aliceText, /^relayed: /);

  alice.conn.close();
  bob.conn.close();
});

test("the host still enforces the token — the relay never sees it", async (t) => {
  const { relay, url } = await startRelay();
  const { server } = await startRoom(url, "guarded", "the-real-token");
  t.after(async () => {
    await server.close();
    await relay.close();
  });

  await assert.rejects(
    () => connect(`${url}/r/guarded?t=wrong`, "mallory"),
    /bad or missing room token|closed/,
  );
  const ok = await connect(`${url}/r/guarded?t=the-real-token`, "alice");
  assert.equal(ok.name, "alice");
  ok.conn.close();
});

test("joining a room the relay does not host fails clearly", async (t) => {
  const { relay, url } = await startRelay();
  t.after(async () => await relay.close());
  await assert.rejects(() => connect(`${url}/r/ghost`, "alice"), /no room named/);
});

test("two hosts cannot claim the same room name", async (t) => {
  const { relay, url } = await startRelay();
  const first = await startRoom(url, "taken", null);
  t.after(async () => {
    await first.server.close();
    await relay.close();
  });
  await assert.rejects(() => startRoom(url, "taken", null), /already hosted/);
});

test("when the host goes away, the relay drops the room and its seats", async (t) => {
  const { relay, url } = await startRelay();
  const { server, joinUrl } = await startRoom(url, "fragile", null);
  t.after(async () => await relay.close());

  const alice = await connect(joinUrl, "alice");
  const closed = new Promise<string>((r) => alice.conn.on("closed", r));
  assert.equal(relay.roomCount, 1);

  await server.close();
  const why = await closed;
  assert.match(why, /room closed|host disconnected|1001/);
  // The relay learns about it when the host's own socket drops.
  for (let i = 0; i < 100 && relay.roomCount > 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(relay.roomCount, 0, "the room is gone with its host");
});

test("the relay caps seats per room", async (t) => {
  const { relay, url } = await startRelay({ maxPeers: 1 });
  const { server, joinUrl } = await startRoom(url, "small", null);
  t.after(async () => {
    await server.close();
    await relay.close();
  });
  const alice = await connect(joinUrl, "alice");
  await assert.rejects(() => connect(joinUrl, "bob"), /full|closed/);
  alice.conn.close();
});

test("the relay rate-limits join attempts it cannot authenticate", async (t) => {
  const { relay, url } = await startRelay({ joinsPerMinute: 2 });
  const { server, joinUrl } = await startRoom(url, "limited", "tok");
  t.after(async () => {
    await server.close();
    await relay.close();
  });

  // Two guesses are allowed through to the host, which refuses them; the third
  // never reaches the host at all.
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) {
    codes.push(
      await new Promise<number>((r) => {
        const ws = new WebSocket(`${url}/r/limited?t=guess${i}`);
        ws.on("close", (code) => r(code));
        ws.on("error", () => r(-1));
      }),
    );
  }
  assert.equal(codes[2], 4429, "the third attempt is refused by the relay itself");
});

test("the relay reports its own health", async (t) => {
  const { relay, port } = await startRelay();
  t.after(async () => await relay.close());
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = (await res.json()) as any;
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.rooms, 0);
});
