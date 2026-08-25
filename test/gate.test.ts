import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, renderTally } from "../src/core/gate.js";
import type { GatePolicy, Participant, Proposal, Vote } from "../src/protocol.js";
import { applyOverrides, parseDuration, resolvePreset } from "../src/core/policy.js";

function person(id: string, role: Participant["role"] = "member"): Participant {
  return { id, name: id, color: 0, role, joinedAt: 0, connected: true, typing: false };
}

function proposal(authorId: string, votes: Record<string, Vote> = {}, deadline: number | null = null): Proposal {
  return {
    id: "#1",
    kind: "prompt",
    authorId,
    authorName: authorId,
    text: "do the thing",
    createdAt: 0,
    deadline,
    votes: Object.fromEntries(Object.entries(votes).map(([k, v]) => [k, { vote: v, at: 0 }])),
    edits: [],
    status: "open",
  };
}

function gate(p: Partial<GatePolicy> = {}): GatePolicy {
  return {
    mode: "majority",
    quorum: 2,
    veto: false,
    autoApproveMs: null,
    minYesOnTimeout: 0,
    proposerAutoYes: true,
    soloBypass: true,
    ...p,
  };
}

const ctx = (people: Participant[], now = 0, ownerId: string | null = "alice") => ({
  participants: people,
  ownerId,
  micHolderId: null,
  now,
});

test("majority: the author alone is not a majority of three", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  const t = evaluate(proposal("alice"), gate(), ctx(people));
  assert.equal(t.decision, "pending");
  assert.equal(t.yes, 1);
  assert.equal(t.need, 1);
});

test("majority: one more approval carries it", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  const t = evaluate(proposal("alice", { bob: "yes" }), gate(), ctx(people));
  assert.equal(t.decision, "approve");
});

test("veto beats a majority", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  const t = evaluate(
    proposal("alice", { bob: "yes", carol: "no" }),
    gate({ veto: true }),
    ctx(people),
  );
  assert.equal(t.decision, "reject");
  assert.match(t.reason, /vetoed/);
});

test("a veto comment is surfaced as the reason", () => {
  const people = [person("alice"), person("bob")];
  const p = proposal("alice");
  p.votes.bob = { vote: "no", at: 0, comment: "that would drop the prod table" };
  const t = evaluate(p, gate({ veto: true }), ctx(people));
  assert.match(t.reason, /prod table/);
});

test("consensus needs everyone present", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  const g = gate({ mode: "consensus" });
  assert.equal(evaluate(proposal("alice", { bob: "yes" }), g, ctx(people)).decision, "pending");
  assert.equal(
    evaluate(proposal("alice", { bob: "yes", carol: "yes" }), g, ctx(people)).decision,
    "approve",
  );
});

test("consensus does not deadlock on someone who disconnected", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  people[2]!.connected = false;
  const t = evaluate(proposal("alice", { bob: "yes" }), gate({ mode: "consensus" }), ctx(people));
  assert.equal(t.decision, "approve", "the electorate is who is actually here");
});

test("observers neither vote nor count toward the electorate", () => {
  const people = [person("alice"), person("bob"), person("dave", "observer")];
  const t = evaluate(proposal("alice", { bob: "yes" }), gate({ mode: "consensus" }), ctx(people));
  assert.equal(t.electorate, 2);
  assert.equal(t.decision, "approve");
});

test("a rejection is declared as soon as the threshold is unreachable", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  const t = evaluate(
    proposal("alice", { bob: "no", carol: "no" }),
    gate({ mode: "majority", veto: false }),
    ctx(people),
  );
  assert.equal(t.decision, "reject", "2 of 3 said no, so 2 yes votes can never happen");
});

test("quorum counts approvals, not proportions", () => {
  const people = [person("a"), person("b"), person("c"), person("d"), person("e")];
  const g = gate({ mode: "quorum", quorum: 3 });
  assert.equal(evaluate(proposal("a", { b: "yes" }), g, ctx(people)).decision, "pending");
  assert.equal(evaluate(proposal("a", { b: "yes", c: "yes" }), g, ctx(people)).decision, "approve");
});

test("quorum larger than the room falls back to the whole room", () => {
  const people = [person("a"), person("b")];
  const t = evaluate(proposal("a", { b: "yes" }), gate({ mode: "quorum", quorum: 9 }), ctx(people));
  assert.equal(t.decision, "approve");
});

test("lazy consensus: silence approves once the timer fires", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  const g = gate({ mode: "consensus", autoApproveMs: 20_000 });
  const p = proposal("alice", {}, 20_000);
  assert.equal(evaluate(p, g, ctx(people, 19_999)).decision, "pending");
  assert.equal(evaluate(p, g, ctx(people, 20_000)).decision, "approve");
});

test("a timer with minYes rejects when nobody spoke up", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  const g = gate({ mode: "consensus", autoApproveMs: 1000, minYesOnTimeout: 2, proposerAutoYes: false });
  assert.equal(evaluate(proposal("alice", {}, 1000), g, ctx(people, 5000)).decision, "reject");
  assert.equal(
    evaluate(proposal("alice", { bob: "yes", carol: "yes" }, 1000), g, ctx(people, 5000)).decision,
    "approve",
  );
});

test("owner mode answers to the host and nobody else", () => {
  const people = [person("alice", "owner"), person("bob"), person("carol")];
  const g = gate({ mode: "owner", proposerAutoYes: true });
  assert.equal(evaluate(proposal("bob", { carol: "yes" }), g, ctx(people)).decision, "pending");
  assert.equal(evaluate(proposal("bob", { alice: "yes" }), g, ctx(people)).decision, "approve");
  assert.equal(evaluate(proposal("bob", { alice: "no" }), g, ctx(people)).decision, "reject");
});

test("owner mode holds rather than guessing while the host is away", () => {
  const people = [person("bob"), person("carol")];
  const t = evaluate(proposal("bob"), gate({ mode: "owner" }), ctx(people, 0, "alice"));
  assert.equal(t.decision, "pending");
  assert.match(t.reason, /host/);
});

test("solo bypass keeps a one-person room usable", () => {
  const t = evaluate(proposal("alice"), gate({ mode: "consensus" }), ctx([person("alice")]));
  assert.equal(t.decision, "approve");
  assert.equal(t.reason, "solo session");
});

test("solo bypass does not extend to tool calls", () => {
  const p = proposal("agent");
  p.kind = "tool";
  p.tool = { toolUseId: "t1", name: "bash", input: {}, risk: "exec", summary: "bash: rm -rf /" };
  const t = evaluate(p, gate({ mode: "consensus" }), ctx([person("alice")]));
  assert.equal(t.decision, "pending", "a lone operator should still be asked before a shell runs");
});

test("nothing is sent while the room is empty", () => {
  const t = evaluate(proposal("ghost"), gate(), ctx([]));
  assert.equal(t.decision, "pending");
});

test("round-robin only lets the mic holder through", () => {
  const people = [person("alice"), person("bob")];
  const g = gate({ mode: "round-robin" });
  const withMic = { ...ctx(people), micHolderId: "alice" };
  assert.equal(evaluate(proposal("alice"), g, withMic).decision, "approve");
  assert.equal(evaluate(proposal("bob"), g, withMic).decision, "reject");
});

test("open mode sends everything straight through", () => {
  const people = [person("a"), person("b"), person("c")];
  assert.equal(evaluate(proposal("a"), gate({ mode: "open" }), ctx(people)).decision, "approve");
});

test("votes from people who have left are ignored", () => {
  const people = [person("alice"), person("bob")];
  const t = evaluate(proposal("alice", { ghost: "yes", ghost2: "yes" }), gate({ mode: "consensus" }), ctx(people));
  assert.equal(t.yes, 1, "only alice's implicit vote counts");
  assert.equal(t.decision, "pending");
});

test("tally rendering shows what the room is waiting on", () => {
  const people = [person("alice"), person("bob"), person("carol")];
  const t = evaluate(proposal("alice", {}, 30_000), gate({ mode: "consensus", autoApproveMs: 30_000 }), ctx(people, 12_000));
  const line = renderTally(t, 30_000, 12_000);
  assert.match(line, /1\/3 ✓/);
  assert.match(line, /2 pending/);
  assert.match(line, /18s left/);
});

test("duration parsing accepts the shapes people actually type", () => {
  assert.equal(parseDuration("30"), 30_000);
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("2m"), 120_000);
  assert.equal(parseDuration("1h"), 3_600_000);
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration("soon"), null);
});

test("policy overrides apply, and typos are reported not swallowed", () => {
  const base = resolvePreset("team")!;
  const ok = applyOverrides(base, ["mode=quorum", "quorum=3", "tool.mode=consensus", "autoAllow=read,write"]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.policy.prompt.mode, "quorum");
  assert.equal(ok.policy.prompt.quorum, 3);
  assert.equal(ok.policy.tool.mode, "consensus");
  assert.deepEqual(ok.policy.autoAllowToolRisks, ["read", "write"]);

  const bad = applyOverrides(base, ["mode=democracy", "wat=1", "autoAllow=rm"]);
  assert.equal(bad.errors.length, 3);
  assert.equal(bad.policy.prompt.mode, base.prompt.mode, "a rejected override changes nothing");
});

test("every named preset is well formed", () => {
  for (const name of ["solo", "pair", "team", "strict", "host", "round-robin"]) {
    const p = resolvePreset(name);
    assert.ok(p, `${name} exists`);
    assert.ok(p!.prompt.mode);
    assert.ok(Array.isArray(p!.autoAllowToolRisks));
  }
  assert.equal(resolvePreset("nope"), null);
});

test("strict preset never auto-allows a tool and never auto-approves", () => {
  const p = resolvePreset("strict")!;
  assert.deepEqual(p.autoAllowToolRisks, []);
  assert.equal(p.prompt.autoApproveMs, null);
  assert.equal(p.tool.autoApproveMs, null);
  assert.equal(p.prompt.proposerAutoYes, false);
});
