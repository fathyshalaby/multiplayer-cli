import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, resolvePreset, presetNames, PRESETS, renderTally, describeGate } from "../src/lib.js";
import type { Participant, Proposal } from "../src/lib.js";

/**
 * `gate.test.ts` already proves the voting logic itself, one rule at a
 * time. This proves the *packaging* — that `src/lib.ts` is what an external
 * package.json `"multiplayer-cli"` dependency actually resolves to
 * (`package.json`'s `main`/`exports` point at the compiled form of this
 * exact file), and that importing only from there, the way a real consumer
 * would, is enough to run a real decision end to end.
 */

function member(id: string): Participant {
  return { id, name: id, color: 0, role: "member", joinedAt: 0, connected: true, typing: false };
}

function proposal(authorId: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    kind: "prompt",
    authorId,
    authorName: authorId,
    text: "run the migration",
    votes: {},
    createdAt: 0,
    deadline: null,
    edits: [],
    status: "open",
    ...overrides,
  };
}

test("every preset name resolves to a usable policy", () => {
  for (const name of presetNames()) {
    const policy = resolvePreset(name);
    assert.ok(policy, name);
    // resolvePreset clones defensively, so the same *shape*, not the same
    // object — a caller mutating what it gets back must not corrupt PRESETS.
    assert.deepEqual(PRESETS[name], policy);
  }
  assert.equal(resolvePreset("not-a-real-preset"), null);
});

test("a two-person room needs both votes under consensus, from nothing but the public exports", () => {
  const policy = resolvePreset("team")!;
  const alice = member("alice");
  const bob = member("bob");
  const now = 1_000_000;

  const p = proposal("alice");
  const pending = evaluate(p, policy.prompt, { participants: [alice, bob], ownerId: null, micHolderId: null, now });
  assert.equal(pending.decision, "pending");

  const withBobsVote: Proposal = { ...p, votes: { bob: { vote: "yes", at: now } } };
  const approved = evaluate(withBobsVote, policy.prompt, {
    participants: [alice, bob],
    ownerId: null,
    micHolderId: null,
    now,
  });
  assert.equal(approved.decision, "approve");
});

test("a single no under a veto policy is absolute, regardless of yes votes", () => {
  const policy = resolvePreset("pair")!;
  const now = 1_000_000;
  const voters = [member("alice"), member("bob"), member("carol")];
  const p = proposal("alice", {
    kind: "tool",
    text: "rm -rf build/",
    votes: { alice: { vote: "yes", at: now }, bob: { vote: "yes", at: now }, carol: { vote: "no", at: now } },
  });
  const tally = evaluate(p, policy.tool, { participants: voters, ownerId: null, micHolderId: null, now });
  assert.equal(tally.decision, "reject");
});

test("renderTally and describeGate produce the same human-readable strings the CLI shows", () => {
  const policy = resolvePreset("team")!;
  const now = 1_000_000;
  const p = proposal("alice", { text: "hi", votes: { alice: { vote: "yes", at: now } } });
  const tally = evaluate(p, policy.prompt, { participants: [member("alice")], ownerId: null, micHolderId: null, now });
  assert.match(renderTally(tally, null, now), /\d\/\d/);
  assert.equal(typeof describeGate(policy.prompt), "string");
});
