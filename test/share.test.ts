import test from "node:test";
import assert from "node:assert/strict";
import { Relay } from "../src/server/relay.js";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport, RelayTransport } from "../src/server/transport.js";
import { parseJoinTarget, isLocalHost } from "../src/util/url.js";
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
    pool: false,
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

test("a share link yields a URL with no secret in it, plus the key", () => {
  const t = parseJoinTarget("https://relay.example.com/s/amber-ridge-04#t=Kf3nQ");
  assert.equal(t.url, "wss://relay.example.com/r/amber-ridge-04", "the token is not in the URL");
  assert.equal(t.room, "amber-ridge-04");
  assert.equal(t.token, "Kf3nQ");
  assert.equal(t.plaintext, false);
});

test("an http share link maps to ws, and is flagged as plaintext", () => {
  const t = parseJoinTarget("http://192.168.1.20:7777/s/dusk-vale-11#t=abc");
  assert.equal(t.url, "ws://192.168.1.20:7777/r/dusk-vale-11");
  assert.equal(t.token, "abc");
  assert.equal(t.plaintext, true);
});

test("an older link with the token in the query still works, but the token is lifted out", () => {
  const t = parseJoinTarget("ws://relay/r/room?t=abc");
  assert.equal(t.url, "ws://relay/r/room", "and is not passed on");
  assert.equal(t.token, "abc");
});

test("a room with no token parses as one with no key", () => {
  const t = parseJoinTarget("ws://127.0.0.1:7777/r/open-room");
  assert.equal(t.token, null);
  assert.equal(t.room, "open-room");
});

test("a link pasted with the usual chat debris still works", () => {
  const t = parseJoinTarget("  <https://relay.example.com/s/room#t=tok>  ");
  assert.equal(t.url, "wss://relay.example.com/r/room");
  assert.equal(t.token, "tok");
});

test("local addresses are recognised, public ones are not", () => {
  for (const local of [
    "ws://127.0.0.1:7777/",
    "ws://localhost:7777/",
    "ws://192.168.1.20:7777/",
    "ws://10.0.0.5:7777/",
    "ws://172.16.4.1:7777/",
    "ws://box.local:7777/",
  ]) {
    assert.equal(isLocalHost(local), true, local);
  }
  for (const public_ of ["ws://relay.example.com/", "ws://8.8.8.8/", "ws://172.32.0.1/"]) {
    assert.equal(isLocalHost(public_), false, public_);
  }
});

/* ---- the browser seat ------------------------------------------- */

test("the browser seat is one self-contained page that fetches nothing", () => {
  const html = sessionPage();
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes("multiplayer-cli"));

  // Check for actual ways to make a request, rather than for anything that
  // looks like a URL — a scheme inside a comment is not a network call.
  assert.ok(!/<script[^>]+\bsrc\s*=/i.test(html), "no remote scripts");
  assert.ok(!/<link[^>]+\bhref\s*=/i.test(html), "no remote stylesheets");
  assert.ok(!/<img[^>]+\bsrc\s*=/i.test(html), "no remote images");
  assert.ok(!/\bfetch\s*\(/.test(html), "no fetch");
  assert.ok(!/XMLHttpRequest|EventSource|importScripts/.test(html), "no other transports");
  assert.ok(!/@import|url\(\s*['\"]?https?:/i.test(html), "no CSS imports");

  assert.ok(html.includes("location.hash"), "it reads the token from the fragment");
  assert.ok(html.includes("AES-GCM"), "and encrypts what it sends with it");
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
  assert.match(info.selfUrl("tok"), /^ws:\/\/127\.0\.0\.1:\d+\/r\/served$/);
  assert.ok(!info.joinUrl("tok").includes("tok"), "the dial URL carries no secret");
});

test("a relayed room serves the seat from the relay", async (t) => {
  const relay = new Relay({ host: "127.0.0.1", port: 0, maxRooms: 4, maxPeersPerRoom: 4, joinsPerMinute: 60, directory: false });
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
