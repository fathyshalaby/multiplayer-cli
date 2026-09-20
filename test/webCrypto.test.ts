import test from "node:test";
import assert from "node:assert/strict";
import { deriveAuthKey } from "../src/core/crypto.js";
import { SecureChannel } from "../src/core/secure.js";
import {
  deriveAuthKeyWeb,
  newEphemeralWeb,
  handshakeMacWeb,
  macMatchesWeb,
  deriveSessionKeyWeb,
  randomNonceWeb,
  sealWeb,
  openWeb,
  type EphemeralWeb,
} from "../src/browser/webCrypto.js";

/**
 * Proves the WebCrypto reimplementation a browser extension would run in its
 * service worker agrees, byte for byte, with the `node:crypto` implementation
 * the host and every other seat run. Two independent AES-GCM/ECDH
 * implementations only earn trust by actually interoperating, not by each
 * passing its own tests — so every test here has one side speak
 * `core/crypto.ts`/`core/secure.ts` and the other speak `webCrypto.ts`.
 */

const TOKEN = "s3cret-token";
const ROOM = "amber-ridge-04";

test("deriveAuthKey agrees between node:crypto and WebCrypto", async () => {
  const nodeKey = deriveAuthKey(TOKEN, ROOM);
  const webKey = await deriveAuthKeyWeb(TOKEN, ROOM);
  assert.deepEqual(Buffer.from(webKey), nodeKey);
});

/**
 * Mirrors the client half of `SecureChannel.handshake` in `core/secure.ts`,
 * using only `webCrypto.ts` primitives — this is what an extension's
 * background worker would run when the room server is the "server" side.
 */
async function webClientHandshake(authKey: Uint8Array, room: string) {
  const mine = await newEphemeralWeb();
  const myNonce = randomNonceWeb();
  const mac = await handshakeMacWeb(authKey, "mpx-client", mine.pub, myNonce);
  const openingFrame = JSON.stringify({
    h: 2,
    epk: Buffer.from(mine.pub).toString("base64"),
    n: Buffer.from(myNonce).toString("base64"),
    mac: Buffer.from(mac).toString("base64"),
  });
  return {
    openingFrame,
    async finish(replyFrame: string): Promise<Uint8Array> {
      const msg = JSON.parse(replyFrame) as { h: number; epk: string; n: string; mac: string };
      assert.equal(msg.h, 2);
      const peerPub = new Uint8Array(Buffer.from(msg.epk, "base64"));
      const peerNonce = new Uint8Array(Buffer.from(msg.n, "base64"));
      const claimed = new Uint8Array(Buffer.from(msg.mac, "base64"));
      const expected = await handshakeMacWeb(authKey, "mpx-server", peerPub, peerNonce, mine.pub, myNonce);
      assert.equal(macMatchesWeb(claimed, expected), true, "the server's MAC must verify");
      const shared = await mine.computeSecret(peerPub);
      return deriveSessionKeyWeb(shared, myNonce, peerNonce, room);
    },
  };
}

/**
 * Mirrors the server half, for the case where the extension is the one
 * accepting a connection (e.g. relaying between two of a room's own seats).
 */
async function webServerHandshake(authKey: Uint8Array, room: string, openingFrame: string) {
  const msg = JSON.parse(openingFrame) as { h: number; epk: string; n: string; mac: string };
  assert.equal(msg.h, 2);
  const peerPub = new Uint8Array(Buffer.from(msg.epk, "base64"));
  const peerNonce = new Uint8Array(Buffer.from(msg.n, "base64"));
  const claimed = new Uint8Array(Buffer.from(msg.mac, "base64"));
  const expected = await handshakeMacWeb(authKey, "mpx-client", peerPub, peerNonce);
  assert.equal(macMatchesWeb(claimed, expected), true, "the client's MAC must verify");

  const mine: EphemeralWeb = await newEphemeralWeb();
  const myNonce = randomNonceWeb();
  const shared = await mine.computeSecret(peerPub);
  const sessionKey = await deriveSessionKeyWeb(shared, peerNonce, myNonce, room);
  const mac = await handshakeMacWeb(authKey, "mpx-server", mine.pub, myNonce, peerPub, peerNonce);
  const replyFrame = JSON.stringify({
    h: 2,
    epk: Buffer.from(mine.pub).toString("base64"),
    n: Buffer.from(myNonce).toString("base64"),
    mac: Buffer.from(mac).toString("base64"),
  });
  return { replyFrame, sessionKey };
}

test("a WebCrypto client and a node:crypto server agree on the same session key", async () => {
  const authKeyNode = deriveAuthKey(TOKEN, ROOM);
  const authKeyWeb = new Uint8Array(authKeyNode);

  const server = new SecureChannel(authKeyNode, ROOM, "server");
  const client = await webClientHandshake(authKeyWeb, ROOM);

  const step = server.handshake(client.openingFrame);
  assert.equal(step.ok, true);
  assert.equal(step.ready, true);
  assert.ok(step.reply);

  const webSessionKey = await client.finish(step.reply!);

  // Neither side ever exposes its session key directly — that is the point
  // of the class. Prove they match functionally: what one seals, the other
  // opens, in both directions.
  const fromServer = server.wrap(JSON.stringify({ hello: "from the room" }));
  const openedByWeb = await openWeb(webSessionKey, ROOM, fromServer);
  assert.equal(openedByWeb?.seq, 0);
  assert.deepEqual(JSON.parse(openedByWeb!.text), { hello: "from the room" });

  const fromWeb = await sealWeb(webSessionKey, ROOM, 0, JSON.stringify({ hello: "from the extension" }));
  const openedByServer = server.unwrap(fromWeb);
  assert.deepEqual(JSON.parse(openedByServer!), { hello: "from the extension" });
});

test("a node:crypto client and a WebCrypto server agree on the same session key", async () => {
  const authKeyNode = deriveAuthKey(TOKEN, ROOM);
  const authKeyWeb = new Uint8Array(authKeyNode);

  const client = new SecureChannel(authKeyNode, ROOM, "client");
  const openingFrame = client.begin();
  assert.ok(openingFrame);

  const server = await webServerHandshake(authKeyWeb, ROOM, openingFrame!);
  const step = client.handshake(server.replyFrame);
  assert.equal(step.ok, true);
  assert.equal(step.ready, true);

  const fromClient = client.wrap(JSON.stringify({ hello: "from the node client" }));
  const openedByWeb = await openWeb(server.sessionKey, ROOM, fromClient);
  assert.equal(openedByWeb?.seq, 0);
  assert.deepEqual(JSON.parse(openedByWeb!.text), { hello: "from the node client" });

  const fromWeb = await sealWeb(server.sessionKey, ROOM, 0, JSON.stringify({ hello: "from the web server" }));
  const openedByClient = client.unwrap(fromWeb);
  assert.deepEqual(JSON.parse(openedByClient!), { hello: "from the web server" });
});

test("a WebCrypto client rejects a tampered server reply", async () => {
  const authKeyNode = deriveAuthKey(TOKEN, ROOM);
  const authKeyWeb = new Uint8Array(authKeyNode);

  const server = new SecureChannel(authKeyNode, ROOM, "server");
  const client = await webClientHandshake(authKeyWeb, ROOM);
  const step = server.handshake(client.openingFrame);
  assert.ok(step.reply);

  const tampered = JSON.parse(step.reply!);
  tampered.mac = Buffer.alloc(32).toString("base64"); // right length, wrong content
  await assert.rejects(() => client.finish(JSON.stringify(tampered)));
});

test("a node:crypto server rejects a client whose MAC does not match its own auth key", () => {
  const server = new SecureChannel(deriveAuthKey(TOKEN, ROOM), ROOM, "server");
  const impostor = new SecureChannel(deriveAuthKey("wrong-token", ROOM), ROOM, "client");
  const openingFrame = impostor.begin();
  const step = server.handshake(openingFrame!);
  assert.equal(step.ok, false);
});

test("sealed frames interoperate byte for byte, including tamper detection", async () => {
  const key = randomNonceWeb(32);
  const frame = await sealWeb(key, ROOM, 3, "the original message");
  const opened = await openWeb(key, ROOM, frame);
  assert.equal(opened?.seq, 3);
  assert.equal(opened?.text, "the original message");

  const raw = Buffer.from(frame, "base64");
  raw[20] = raw[20]! ^ 0x01;
  assert.equal(await openWeb(key, ROOM, raw.toString("base64")), null);
});

test("a WebCrypto-sealed frame is rejected for the wrong room, same as the node implementation", async () => {
  const key = randomNonceWeb(32);
  const frame = await sealWeb(key, "room-one", 0, "secret");
  assert.equal(await openWeb(key, "room-two", frame), null);
});
