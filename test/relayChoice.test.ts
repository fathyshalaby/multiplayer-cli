import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { chooseRelay, DEFAULT_RELAY, type RelayChoiceInput } from "../src/server/relayChoice.js";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport, RelayTransport, listenWithFallback } from "../src/server/transport.js";
import { Relay } from "../src/server/relay.js";
import { resolvePreset } from "../src/core/policy.js";
import type { AgentBackend, TurnResult } from "../src/agent/types.js";

/**
 * `mpx share` goes through a hosted relay by default. Each rule about when it
 * does and does not is one test here, the way every voting rule is one test in
 * gate.test.ts. That works because chooseRelay is pure, and it matters because
 * these rules decide where a room's traffic goes.
 */

const BUILTIN = "wss://builtin.example";

function input(over: Partial<RelayChoiceInput> = {}): RelayChoiceInput {
  return {
    explicit: "",
    easy: true,
    local: false,
    lan: false,
    open: false,
    saved: null,
    env: undefined,
    builtin: BUILTIN,
    ...over,
  };
}

/* ---- the rules ------------------------------------------------- */

test("share with nothing configured goes through the built-in relay", () => {
  assert.deepEqual(chooseRelay(input()), { url: BUILTIN, source: "default", note: null });
});

test("the built-in relay is a wss:// address, so connection metadata is not in the clear either", () => {
  assert.match(DEFAULT_RELAY, /^wss:\/\//);
});

test("--relay wins over everything, on every command", () => {
  const url = "wss://mine.example";
  assert.equal(chooseRelay(input({ explicit: url, saved: "wss://saved", env: "wss://env" })).url, url);
  assert.equal(chooseRelay(input({ explicit: url, easy: false })).source, "flag");
});

test("host and serve still relay only when asked, as before", () => {
  assert.equal(chooseRelay(input({ easy: false })).url, null);
  assert.equal(chooseRelay(input({ easy: false, saved: "wss://saved" })).url, null);
});

test("--local and --lan both keep the room off every relay", () => {
  assert.equal(chooseRelay(input({ local: true })).url, null);
  assert.equal(chooseRelay(input({ lan: true })).url, null);
  assert.equal(chooseRelay(input({ lan: true, saved: "wss://saved", env: "wss://env" })).url, null);
});

test("MPX_RELAY with a URL replaces the built-in, and beats a saved relay", () => {
  assert.deepEqual(chooseRelay(input({ env: "wss://env" })), { url: "wss://env", source: "env", note: null });
  assert.equal(chooseRelay(input({ env: "wss://env", saved: "wss://saved" })).url, "wss://env");
});

test("MPX_RELAY=off turns off every relay nobody named on the command line", () => {
  for (const off of ["off", "OFF", "none", "0", "false", "lan", " off "]) {
    assert.equal(chooseRelay(input({ env: off })).url, null, off);
    assert.equal(chooseRelay(input({ env: off, saved: "wss://saved" })).url, null, off);
  }
  assert.equal(chooseRelay(input({ env: "off", explicit: "wss://mine" })).url, "wss://mine");
});

test("a saved relay beats the built-in", () => {
  assert.deepEqual(chooseRelay(input({ saved: "wss://saved" })), { url: "wss://saved", source: "saved", note: null });
});

test("an empty MPX_RELAY is the same as unset", () => {
  assert.equal(chooseRelay(input({ env: "  " })).source, "default");
});

test("an --open room never goes through a relay it did not name, and says why", () => {
  // No token means no key, so every frame would reach the relay readable.
  const c = chooseRelay(input({ open: true }));
  assert.equal(c.url, null);
  assert.match(c.note ?? "", /--open/);
  assert.equal(chooseRelay(input({ open: true, saved: "wss://saved" })).url, null);
  assert.equal(chooseRelay(input({ open: true, env: "wss://env" })).url, null);
});

test("an --open room still goes through a relay the host names explicitly", () => {
  assert.equal(chooseRelay(input({ open: true, explicit: "wss://mine" })).url, "wss://mine");
});

/* ---- falling back when the relay is not there ------------------- */

class Quiet implements AgentBackend {
  readonly name = "quiet";
  readonly model = "";
  async send(): Promise<TurnResult> {
    return { stopReason: "end_turn" };
  }
  async close(): Promise<void> {}
}

function room(transport: LocalWsTransport | RelayTransport, name: string) {
  return new RoomServer({
    transport,
    roomName: name,
    token: "sekrit",
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
    lanes: 0,
    laneSetup: null,
    transcriptPath: null,
    backendFactory: () => new Quiet(),
  });
}

/** A port with nothing listening on it: bind, note the port, close. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Accepts TCP connections and never says anything: a relay that has hung. */
async function silentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const s: Server = createServer((sock) => sockets.push(sock));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return {
    port: (s.address() as { port: number }).port,
    close: async () => {
      for (const sock of sockets) sock.destroy();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}

test("a relay that hangs is given up on after timeoutMs, not the 15-second default", async (t) => {
  const silent = await silentServer();
  t.after(() => silent.close());
  const started = Date.now();
  const r = room(new RelayTransport({ url: `ws://127.0.0.1:${silent.port}`, roomName: "hung", timeoutMs: 300 }), "hung");
  await assert.rejects(r.listen());
  const took = Date.now() - started;
  assert.ok(took < 5_000, `gave up after ${took}ms`);
});

test("the built-in relay being down falls back to a room on the local network", async (t) => {
  const port = await deadPort();
  const fellBackWith: string[] = [];
  const relayWarnings: string[] = [];
  const { server, info, fellBack } = await listenWithFallback(
    () =>
      room(
        new RelayTransport({
          url: `ws://127.0.0.1:${port}`,
          roomName: "fb",
          timeoutMs: 1_000,
          onWarn: (w) => relayWarnings.push(w),
        }),
        "fb",
      ),
    () => room(new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "fb" }), "fb"),
    (err) => fellBackWith.push(err.message),
  );
  t.after(() => server.close());
  assert.equal(fellBack, true);
  assert.equal(fellBackWith.length, 1);
  assert.match(fellBackWith[0]!, /relay/);
  // The failed dial's socket still closes afterwards. That is not a relay the
  // room lost, and the host should not be told to send a new invite for it.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(relayWarnings, []);
  // The room that came up is a real one with a link a browser can open.
  assert.match(info.shareUrl("sekrit") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/s\/fb#t=sekrit$/);
});

test("a relay the host named being down is an error, not a quiet swap", async () => {
  const port = await deadPort();
  let fellBack = false;
  await assert.rejects(
    listenWithFallback(
      () => room(new RelayTransport({ url: `ws://127.0.0.1:${port}`, roomName: "named" }), "named"),
      null,
      () => (fellBack = true),
    ),
    /relay/,
  );
  assert.equal(fellBack, false);
});

test("a reachable relay is used, and nothing falls back", async (t) => {
  const relay = new Relay({ host: "127.0.0.1", port: 0, maxRooms: 4, maxPeersPerRoom: 4, joinsPerMinute: 60, directory: false });
  const port = await relay.listen();
  t.after(() => relay.close());
  let fellBack = false;
  const { server, info } = await listenWithFallback(
    () => room(new RelayTransport({ url: `ws://127.0.0.1:${port}`, roomName: "up", timeoutMs: 2_000 }), "up"),
    () => room(new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "up" }), "up"),
    () => (fellBack = true),
  );
  t.after(() => server.close());
  assert.equal(fellBack, false);
  assert.match(info.shareUrl("sekrit") ?? "", new RegExp(`^http://127\\.0\\.0\\.1:${port}/s/up#t=sekrit$`));
});
