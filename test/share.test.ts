import test from "node:test";
import assert from "node:assert/strict";
import { Relay } from "../src/server/relay.js";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport, RelayTransport } from "../src/server/transport.js";
import { normalizeJoinUrl } from "../src/util/url.js";
import { shareLink, httpOrigin, sessionPage } from "../src/server/web.js";
import { resolvePreset } from "../src/core/policy.js";
import { onPath } from "../src/util/detect.js";
import type { AgentBackend, TurnResult } from "../src/agent/types.js";

class Quiet implements AgentBackend {
  readonly name = "quiet";
  readonly model = "";
  async send(): Promise<TurnResult> {
    return { stopReason: "end_turn" };
  }
  async close(): Promise<void> {}
}

function room(transport: LocalWsTransport | RelayTransport, name: string, token: string | null) {
  return new RoomServer({
    transport,
    roomName: name,
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
    transcriptPath: null,
    backendFactory: () => new Quiet(),
  });
}

/* ---- the link -------------------------------------------------- */

test("the share link keeps the token in the fragment, off the wire", () => {
  const link = shareLink("https://relay.example.com", "amber-ridge-04", "Kf3nQ");
  assert.equal(link, "https://relay.example.com/s/amber-ridge-04#t=Kf3nQ");
  assert.ok(link.includes("#t="), "browsers never send a fragment to the server");
  assert.ok(!link.includes("?t="), "so it stays out of access logs and referrers");
});

test("a room with no token produces a link with no secret in it", () => {
  assert.equal(shareLink("http://box:7777", "open-room", null), "http://box:7777/s/open-room");
});

test("ws origins map to the http origin a browser would open", () => {
  assert.equal(httpOrigin("wss://relay.example.com"), "https://relay.example.com");
  assert.equal(httpOrigin("ws://127.0.0.1:7788"), "http://127.0.0.1:7788");
});

test("`mpx join` accepts the same link that was clickable in chat", () => {
  assert.equal(
    normalizeJoinUrl("https://relay.example.com/s/amber-ridge-04#t=Kf3nQ"),
    "wss://relay.example.com/r/amber-ridge-04?t=Kf3nQ",
  );
  assert.equal(
    normalizeJoinUrl("http://192.168.1.20:7777/s/dusk-vale-11#t=abc"),
    "ws://192.168.1.20:7777/r/dusk-vale-11?t=abc",
  );
});

test("`mpx join` still accepts the raw WebSocket forms", () => {
  assert.equal(normalizeJoinUrl("ws://127.0.0.1:7777/?t=abc"), "ws://127.0.0.1:7777/?t=abc");
  assert.equal(normalizeJoinUrl("wss://relay/r/room?t=abc"), "wss://relay/r/room?t=abc");
  assert.equal(normalizeJoinUrl("127.0.0.1:7777"), "ws://127.0.0.1:7777");
});

test("a link pasted with the usual chat debris still works", () => {
  assert.equal(
    normalizeJoinUrl("  <https://relay.example.com/s/room#t=tok>  "),
    "wss://relay.example.com/r/room?t=tok",
  );
});

/* ---- the browser seat ------------------------------------------- */

test("the browser seat is one self-contained page with no external requests", () => {
  const html = sessionPage();
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("multiplayer-cli"));
  assert.ok(!/<script[^>]+src=/i.test(html), "no remote scripts");
  assert.ok(!/<link[^>]+href=/i.test(html), "no remote stylesheets");
  assert.ok(!/https?:\/\/(?!localhost)/.test(html.replace(/wss?:\/\//g, "")), "nothing fetched from the internet");
  assert.ok(html.includes("location.hash"), "it reads the token from the fragment");
});

test("a local room serves the seat and a health check", async (t) => {
  const transport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "served" });
  const server = room(transport, "served", "tok");
  const info = await server.listen();
  t.after(async () => await server.close());

  const base = `http://127.0.0.1:${transport.port}`;
  const page = await fetch(`${base}/s/served`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.match(await page.text(), /Join <span id="gate-room"/);

  const health = await fetch(`${base}/health`);
  assert.equal((await health.json() as any).room, "served");

  assert.equal(info.shareUrl("tok"), `${base}/s/served#t=tok`);
  assert.equal(new URL((await fetch(`${base}/nope`)).url).pathname, "/nope");
  assert.match(info.selfUrl("tok"), /^ws:\/\/127\.0\.0\.1:\d+\/\?t=tok$/);
});

test("a relayed room serves the seat from the relay", async (t) => {
  const relay = new Relay({ host: "127.0.0.1", port: 0, maxRooms: 4, maxPeersPerRoom: 4, joinsPerMinute: 60 });
  const port = await relay.listen();
  const transport = new RelayTransport({ url: `ws://127.0.0.1:${port}`, roomName: "far" });
  const server = room(transport, "far", "tok");
  const info = await server.listen();
  t.after(async () => {
    await server.close();
    await relay.close();
  });

  assert.equal(info.shareUrl("tok"), `http://127.0.0.1:${port}/s/far#t=tok`);
  const page = await fetch(`http://127.0.0.1:${port}/s/far`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Join in the browser/);
});

test("the link a local room prints points somewhere teammates can actually reach", async (t) => {
  const transport = new LocalWsTransport({ host: "0.0.0.0", port: 0, roomName: "lan" });
  const server = room(transport, "lan", "tok");
  const info = await server.listen();
  t.after(async () => await server.close());
  // Bound to every interface, so the link must not say 0.0.0.0 — nobody can
  // open that. It resolves to a real address instead.
  const url = info.shareUrl("tok")!;
  assert.ok(!url.includes("0.0.0.0"), url);
  assert.match(url, /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/s\/lan#t=tok$/);
  // The host's own seat still takes loopback, whatever the invite advertises.
  assert.match(info.selfUrl("tok"), /^ws:\/\/127\.0\.0\.1:/);
});

test("a localhost-only room says so instead of handing out a dead link", async (t) => {
  const transport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "priv" });
  const server = room(transport, "priv", null);
  const info = await server.listen();
  t.after(async () => await server.close());
  const detail = info.detail(null).join(" ");
  assert.match(detail, /only works on this machine/);
  assert.match(detail, /--relay/);
});

/* ---- detection --------------------------------------------------- */

test("PATH detection finds a real binary and not an invented one", () => {
  assert.equal(onPath("node"), true);
  assert.equal(onPath("definitely-not-a-real-binary-xyz"), false);
});
