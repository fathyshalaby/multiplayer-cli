import test from "node:test";
import assert from "node:assert/strict";
import { deriveKey, seal, open, SeqGuard, SeqCounter } from "../src/core/crypto.js";

test("a sealed frame round-trips for whoever has the token", () => {
  const a = deriveKey("s3cret-token", "amber-ridge-04");
  const b = deriveKey("s3cret-token", "amber-ridge-04");
  const frame = seal(a, 7, JSON.stringify({ t: "propose", text: "hello" }));
  const got = open(b, frame);
  assert.equal(got?.seq, 7);
  assert.deepEqual(JSON.parse(got!.text), { t: "propose", text: "hello" });
});

test("the wrong token opens nothing", () => {
  const real = deriveKey("s3cret-token", "room");
  const guess = deriveKey("s3cret-tokem", "room");
  assert.equal(open(guess, seal(real, 0, "secret work")), null);
});

test("a frame cannot be replayed into another room", () => {
  const one = deriveKey("same-token", "room-one");
  const two = deriveKey("same-token", "room-two");
  assert.equal(open(two, seal(one, 0, "hi")), null, "the room name is bound into the ciphertext");
});

test("tampering is detected rather than passed through", () => {
  const rk = deriveKey("token", "room");
  const frame = seal(rk, 1, "the original message");
  const raw = Buffer.from(frame, "base64");
  // Flip one bit in the ciphertext body.
  raw[20] = raw[20]! ^ 0x01;
  assert.equal(open(rk, raw.toString("base64")), null);
});

test("truncated and junk frames are refused without throwing", () => {
  const rk = deriveKey("token", "room");
  for (const junk of ["", "not-base64!!", "AAAA", Buffer.alloc(20).toString("base64")]) {
    assert.equal(open(rk, junk), null, junk);
  }
});

test("nonces do not repeat, so the same message seals differently every time", () => {
  const rk = deriveKey("token", "room");
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(seal(rk, i, "identical payload"));
  assert.equal(seen.size, 500);
});

test("the sequence guard refuses replays and reordering", () => {
  const g = new SeqGuard();
  assert.equal(g.accept(0), true);
  assert.equal(g.accept(1), true);
  assert.equal(g.accept(1), false, "a duplicate frame is not accepted twice");
  assert.equal(g.accept(0), false, "nor is an older one");
  assert.equal(g.accept(5), true, "a gap is fine — frames may be dropped, not forged");
});

test("the counter is monotonic from zero", () => {
  const c = new SeqCounter();
  assert.deepEqual([c.next(), c.next(), c.next()], [0, 1, 2]);
});

test("a token is not recoverable from the frames it produces", () => {
  const rk = deriveKey("correct-horse-battery-staple", "room");
  const frame = seal(rk, 0, "some session content");
  const raw = Buffer.from(frame, "base64").toString("utf8");
  assert.ok(!raw.includes("correct-horse"), "the token never appears in the ciphertext");
  assert.ok(!frame.includes("correct-horse"));
});

/* ---- forward secrecy --------------------------------------------- */

import { deriveAuthKey, newEphemeral, handshakeMac, macMatches, deriveSessionKey, randomNonce } from "../src/core/crypto.js";
import { SecureChannel } from "../src/core/secure.js";

/** Run a full handshake between two channels, returning both ends. */
function pair(token: string | null, room = "amber-ridge-04") {
  const auth = token ? deriveAuthKey(token, room) : null;
  const client = new SecureChannel(auth, room, "client");
  const server = new SecureChannel(auth, room, "server");
  const first = client.begin();
  if (!first) return { client, server, ok: true };
  const step = server.handshake(first);
  if (!step.ok || !step.reply) return { client, server, ok: false };
  const back = client.handshake(step.reply);
  return { client, server, ok: back.ok && back.ready };
}

test("a handshake agrees a key both sides can use", () => {
  const { client, server, ok } = pair("s3cret");
  assert.equal(ok, true);
  assert.equal(client.ready, true);
  assert.equal(server.ready, true);

  const frame = client.wrap(JSON.stringify({ t: "propose", text: "ship it" }));
  assert.deepEqual(JSON.parse(server.unwrap(frame)!), { t: "propose", text: "ship it" });
  assert.equal(client.unwrap(server.wrap("and back")), "and back");
});

test("the traffic key is NOT the token — that is the whole point", () => {
  const room = "r";
  const a = pair("same-token", room);
  const b = pair("same-token", room);
  const frame = a.client.wrap("secret work");

  // Same token, same room, different connection: it cannot be read. If the key
  // were derived from the token, this would decrypt.
  assert.equal(b.server.unwrap(frame), null);
  assert.equal(a.server.unwrap(frame), "secret work");
});

test("a recorded session stays unreadable to someone who later gets the link", () => {
  const room = "r";
  const live = pair("the-link-token", room);
  const recorded = [live.client.wrap("the merger closes on Friday"), live.client.wrap("and the price is 40")];

  // The attacker now has the token — everything a leaked link gives them — and
  // runs a fresh handshake with a fresh server. The ephemeral halves that made
  // the old key are gone, so the recording is still just noise.
  const attacker = pair("the-link-token", room);
  for (const frame of recorded) {
    assert.equal(attacker.server.unwrap(frame), null);
    assert.equal(attacker.client.unwrap(frame), null);
  }
});

test("a wrong token cannot complete the handshake", () => {
  const room = "r";
  const server = new SecureChannel(deriveAuthKey("real", room), room, "server");
  const mallory = new SecureChannel(deriveAuthKey("guess", room), room, "client");
  const step = server.handshake(mallory.begin()!);
  assert.equal(step.ok, false);
  assert.equal(server.ready, false);
});

test("a handshake cannot be replayed into another room", () => {
  const client = new SecureChannel(deriveAuthKey("tok", "room-one"), "room-one", "client");
  const other = new SecureChannel(deriveAuthKey("tok", "room-two"), "room-two", "server");
  assert.equal(other.handshake(client.begin()!).ok, false);
});

test("a relay cannot splice one server's reply onto another handshake", () => {
  const room = "r";
  const auth = deriveAuthKey("tok", room);
  const alice = new SecureChannel(auth, room, "client");
  const bob = new SecureChannel(auth, room, "client");
  const server = new SecureChannel(auth, room, "server");

  const forBob = server.handshake(bob.begin()!).reply!;
  // The server's MAC covers the client's half, so Alice rejects a reply that
  // was produced for Bob's handshake.
  alice.begin();
  assert.equal(alice.handshake(forBob).ok, false);
});

test("a malformed or off-curve public key is refused, not turned into a key", () => {
  const room = "r";
  const auth = deriveAuthKey("tok", room);
  const server = new SecureChannel(auth, room, "server");

  const junkPub = Buffer.alloc(65, 0x04);
  const nonce = randomNonce();
  const framed = JSON.stringify({
    h: 2,
    epk: junkPub.toString("base64"),
    n: nonce.toString("base64"),
    mac: handshakeMac(auth, "mpx-client", junkPub, nonce).toString("base64"),
  });
  // Correctly MAC'd by someone holding the token, but not a real curve point.
  assert.equal(server.handshake(framed).ok, false);
  assert.equal(server.ready, false);

  for (const bad of ["{}", "not json", JSON.stringify({ h: 1 }), JSON.stringify({ h: 2, epk: "AA==", n: "AA==", mac: "AA==" })]) {
    assert.equal(new SecureChannel(auth, room, "server").handshake(bad).ok, false, bad);
  }
});

test("nothing flows before the handshake completes", () => {
  const room = "r";
  const auth = deriveAuthKey("tok", room);
  const server = new SecureChannel(auth, room, "server");
  assert.equal(server.ready, false);
  // An unfinished channel refuses to open anything, rather than falling back
  // to plaintext.
  assert.equal(server.unwrap("anything at all"), null);
});

test("an open room has no key and no handshake", () => {
  const { client, server, ok } = pair(null);
  assert.equal(ok, true);
  assert.equal(client.encrypted, false);
  assert.equal(client.ready, true);
  assert.equal(server.unwrap(client.wrap("plain")), "plain");
});

test("handshake MACs are unambiguous about where each field ends", () => {
  const key = deriveAuthKey("t", "r");
  // Without length prefixes these two would MAC identically.
  const a = handshakeMac(key, "L", Buffer.from("ab"), Buffer.from("c"));
  const b = handshakeMac(key, "L", Buffer.from("a"), Buffer.from("bc"));
  assert.equal(macMatches(a, b), false);
});

test("both sides contribute to the key, so neither can fix it alone", () => {
  const shared = Buffer.alloc(32, 7);
  const n1 = randomNonce();
  const n2 = randomNonce();
  const one = deriveSessionKey(shared, n1, n2, "room");
  const two = deriveSessionKey(shared, n1, randomNonce(), "room");
  assert.notEqual(one.key.toString("hex"), two.key.toString("hex"));

  const ephemeral = newEphemeral();
  assert.equal(ephemeral.pub.length, 65);
  assert.equal(ephemeral.pub[0], 0x04);
});
