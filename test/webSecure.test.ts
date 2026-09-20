import test from "node:test";
import assert from "node:assert/strict";
import { deriveAuthKey } from "../src/core/crypto.js";
import { SecureChannel } from "../src/core/secure.js";
import { WebSecureChannel } from "../src/browser/webSecure.js";

/**
 * `WebSecureChannel` is what an extension's background worker would actually
 * hold — the async, WebCrypto-backed twin of `core/secure.ts`'s
 * `SecureChannel`. Every test here runs one real instance of each against
 * the other, the same way `webCrypto.test.ts` proved the primitives
 * underneath agree: a class that only tests against itself could drift from
 * the wire format and never notice.
 */

const ROOM = "amber-ridge-04";

function authKeys(token: string, room: string) {
  const node = deriveAuthKey(token, room);
  return { node, web: new Uint8Array(node) };
}

test("a WebSecureChannel client and a SecureChannel server complete a real handshake and exchange frames both ways", async () => {
  const { node, web } = authKeys("s3cret-token", ROOM);
  const server = new SecureChannel(node, ROOM, "server");
  const client = new WebSecureChannel(web, ROOM, "client");

  const opening = await client.begin();
  assert.ok(opening);
  const serverStep = server.handshake(opening!);
  assert.equal(serverStep.ok, true);
  assert.ok(serverStep.reply);

  const clientStep = await client.handshake(serverStep.reply!);
  assert.equal(clientStep.ok, true);
  assert.equal(clientStep.ready, true);
  assert.equal(server.ready, true);

  const fromServer = server.wrap(JSON.stringify({ from: "server" }));
  assert.deepEqual(JSON.parse((await client.unwrap(fromServer))!), { from: "server" });

  const fromClient = await client.wrap(JSON.stringify({ from: "client" }));
  assert.deepEqual(JSON.parse(server.unwrap(fromClient)!), { from: "client" });
});

test("a SecureChannel client and a WebSecureChannel server complete a real handshake and exchange frames both ways", async () => {
  const { node, web } = authKeys("s3cret-token", ROOM);
  const client = new SecureChannel(node, ROOM, "client");
  const server = new WebSecureChannel(web, ROOM, "server");

  const opening = client.begin();
  assert.ok(opening);
  const serverStep = await server.handshake(opening!);
  assert.equal(serverStep.ok, true);
  assert.ok(serverStep.reply);

  const clientStep = client.handshake(serverStep.reply!);
  assert.equal(clientStep.ok, true);
  assert.equal(clientStep.ready, true);
  assert.equal(server.ready, true);

  const fromClient = client.wrap(JSON.stringify({ from: "client" }));
  assert.deepEqual(JSON.parse((await server.unwrap(fromClient))!), { from: "client" });

  const fromServer = await server.wrap(JSON.stringify({ from: "server" }));
  assert.deepEqual(JSON.parse(client.unwrap(fromServer)!), { from: "server" });
});

test("a WebSecureChannel refuses a handshake authenticated with the wrong token", async () => {
  const good = authKeys("right-token", ROOM);
  const bad = authKeys("wrong-token", ROOM);

  const server = new SecureChannel(good.node, ROOM, "server");
  const impostor = new WebSecureChannel(bad.web, ROOM, "client");

  const opening = await impostor.begin();
  const step = server.handshake(opening!);
  assert.equal(step.ok, false, "the node server must not accept the impostor's MAC");
});

test("WebSecureChannel replay guard rejects a duplicated or reordered frame, same as SecureChannel", async () => {
  const { node, web } = authKeys("token", ROOM);
  const server = new SecureChannel(node, ROOM, "server");
  const client = new WebSecureChannel(web, ROOM, "client");
  const opening = await client.begin();
  const serverStep = server.handshake(opening!);
  await client.handshake(serverStep.reply!);

  const first = server.wrap("one");
  const second = server.wrap("two");
  assert.equal(await client.unwrap(first), "one");
  assert.equal(await client.unwrap(second), "two");
  assert.equal(await client.unwrap(first), null, "a replayed frame is refused");
});

test("an unencrypted (no-token) WebSecureChannel passes plaintext through unchanged", async () => {
  const channel = new WebSecureChannel(null, ROOM, "client");
  assert.equal(channel.encrypted, false);
  assert.equal(channel.ready, true);
  assert.equal(await channel.wrap("hello"), "hello");
  assert.equal(await channel.unwrap("hello"), "hello");
});
