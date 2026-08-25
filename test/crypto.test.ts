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
