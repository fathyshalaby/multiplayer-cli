import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport } from "../src/server/transport.js";
import { resolvePreset } from "../src/core/policy.js";
import { SecureChannel } from "../src/core/secure.js";
import { deriveAuthKey } from "../src/core/crypto.js";
import type { AgentBackend, TurnResult } from "../src/agent/types.js";

const TOKEN = "s3kr1t";
const ROOM = "handshake";
/** Short enough to test, long enough that a real client is never caught by it. */
const WINDOW = 400;

class Quiet implements AgentBackend {
  readonly name = "quiet";
  readonly model = "";
  async send(): Promise<TurnResult> {
    return { stopReason: "end_turn" };
  }
  async close(): Promise<void> {}
}

async function startRoom(t: { after(fn: () => unknown): void }) {
  const transport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: ROOM });
  const server = new RoomServer({
    transport,
    roomName: ROOM,
    token: TOKEN,
    policy: resolvePreset("solo")!,
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
    handshakeMs: WINDOW,
    backendFactory: () => new Quiet(),
  });
  await server.listen();
  t.after(async () => await server.close());
  return transport.port;
}

/** A raw socket, so a test can say things a real client never would. */
function raw(port: number, t?: { after(fn: () => unknown): void }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/r/${ROOM}`);
  // Without this, a failed assertion leaves the socket open and node:test
  // waits on the handle forever — a hang instead of a report.
  t?.after(() => ws.close());
  const frames: string[] = [];
  let closed: number | null = null;
  ws.on("message", (d) => frames.push(d.toString()));
  ws.on("close", (code) => {
    closed = code;
  });
  return {
    ws,
    frames,
    open: () => new Promise<void>((r, j) => {
      ws.once("open", () => r());
      ws.once("error", j);
    }),
    get closedWith() {
      return closed;
    },
    waitForFrame: (ms = 2000) =>
      new Promise<string>((r, j) => {
        if (frames.length) return r(frames[0]!);
        const timer = setTimeout(() => j(new Error("no frame")), ms);
        ws.once("message", (d) => {
          clearTimeout(timer);
          r(d.toString());
        });
      }),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a captured opening frame cannot be replayed to hold a socket open", async (t) => {
  const port = await startRoom(t);

  // A genuine client opens a connection and keeps the frame it sent. Anyone
  // who can see the wire — a relay operator, a proxy — can keep it too.
  const honest = raw(port, t);
  await honest.open();
  const client = new SecureChannel(deriveAuthKey(TOKEN, ROOM), ROOM, "client");
  const opening = client.begin()!;
  honest.ws.send(opening);
  const reply = await honest.waitForFrame();
  assert.equal(client.handshake(reply).ready, true, "the honest client agreed a key");
  // A real client says hello the moment it has a key, which is what proves it.
  honest.ws.send(client.wrap(JSON.stringify({ t: "hello", name: "alice", protocol: 5 })));

  // Replay that exact frame on a fresh socket. The room completes the key
  // agreement — the MAC is genuine — but the replayer has no private half and
  // can never produce a frame that opens under the agreed key.
  const attacker = raw(port, t);
  await attacker.open();
  attacker.ws.send(opening);
  await attacker.waitForFrame();
  assert.equal(attacker.closedWith, null, "still open immediately after the handshake");

  // Finishing the handshake must not stop the clock, or that socket is held
  // for as long as the attacker likes — repeat it and a room fills up with
  // connections that can never say anything.
  await wait(WINDOW * 3);
  assert.equal(attacker.closedWith, 4008, "the replayed socket is dropped");
  // And the seat that proved itself is left alone by the same clock.
  assert.equal(honest.closedWith, null, "a real client is never caught by this");

});

test("a socket that connects and says nothing is dropped", async (t) => {
  const port = await startRoom(t);
  const silent = raw(port, t);
  await silent.open();
  await wait(WINDOW * 3);
  assert.equal(silent.closedWith, 4008);
});

test("a frame sealed with the wrong token never reaches the room", async (t) => {
  const port = await startRoom(t);
  const wrong = raw(port, t);
  await wrong.open();
  const impostor = new SecureChannel(deriveAuthKey("not-the-token", ROOM), ROOM, "client");
  wrong.ws.send(impostor.begin()!);
  await wait(WINDOW);
  assert.equal(wrong.closedWith, 4003, "refused at the handshake, before anything is said");
});
