import test from "node:test";
import assert from "node:assert/strict";
import { Room } from "../src/core/room.js";
import { resolvePreset } from "../src/core/policy.js";
import type { Proposal, ServerMessage } from "../src/protocol.js";

function makeRoom(preset = "team", overrides: Partial<ReturnType<typeof resolvePreset>> = {}) {
  const policy = { ...resolvePreset(preset)!, ...(overrides as object) } as ReturnType<typeof resolvePreset>;
  const sent: ServerMessage[] = [];
  const room = new Room({ name: "test", cwd: "/tmp", policy: policy!, transcriptPath: null });
  room.on("broadcast", (m: ServerMessage) => sent.push(m));
  return { room, sent };
}

function seat(room: Room, name: string) {
  return room.join({ name, role: room.list().length === 0 ? "owner" : "member", connectionId: name });
}

test("the first person in becomes the host", () => {
  const { room } = makeRoom();
  const alice = seat(room, "alice");
  const bob = seat(room, "bob");
  assert.equal(alice.role, "owner");
  assert.equal(bob.role, "member");
  assert.equal(room.owner, "alice");
});

test("duplicate names are made unique rather than rejected", () => {
  const { room } = makeRoom();
  seat(room, "sam");
  const second = seat(room, "sam");
  assert.equal(second.name, "sam2");
});

test("a proposal in a two-person room waits for the other person", () => {
  const { room } = makeRoom("team");
  seat(room, "alice");
  seat(room, "bob");
  const p = room.propose("alice", "refactor the auth module") as Proposal;
  assert.equal(p.status, "open");
  assert.equal(room.queuedIds().length, 0);

  room.vote("bob", p.id, "yes");
  assert.equal(room.queuedIds().length, 1, "approval puts it in the send queue");
});

test("a veto stops the prompt from ever reaching the model", () => {
  const { room, sent } = makeRoom("pair");
  seat(room, "alice");
  seat(room, "bob");
  const p = room.propose("alice", "delete the migrations") as Proposal;
  room.vote("bob", p.id, "no", "we need those");
  assert.equal(room.queuedIds().length, 0);
  const resolved = sent.filter((m) => m.t === "resolved").pop();
  assert.equal(resolved?.t === "resolved" && resolved.proposal.status, "rejected");
  assert.match(String(resolved?.t === "resolved" && resolved.proposal.resolution), /we need those/);
});

test("amending a proposal clears the consent already given to the old wording", () => {
  const { room } = makeRoom("pair");
  seat(room, "alice");
  seat(room, "bob");
  seat(room, "carol");
  const p = room.propose("alice", "drop the users table") as Proposal;
  room.vote("bob", p.id, "yes");
  assert.equal(Object.keys(p.votes).length, 1);

  const err = room.amend("alice", p.id, "archive the users table");
  assert.equal(err, null);
  assert.equal(p.text, "archive the users table");
  assert.deepEqual(p.votes, {}, "bob approved different words");
  assert.equal(p.edits.length, 1);
  assert.equal(p.edits[0]!.from, "drop the users table");
});

test("only the author or the host may amend or withdraw", () => {
  const { room } = makeRoom("team");
  seat(room, "alice");
  seat(room, "bob");
  seat(room, "carol");
  const p = room.propose("bob", "ship it") as Proposal;
  assert.match(String(room.amend("carol", p.id, "hijacked")), /only bob or the host/);
  assert.equal(room.amend("alice", p.id, "ship it carefully"), null, "the host can");
  assert.equal(room.withdraw("bob", p.id), null, "the author can");
});

test("observers can watch but not steer", () => {
  const { room } = makeRoom("team");
  seat(room, "alice");
  room.join({ name: "dave", role: "observer", connectionId: "dave" });
  const result = room.propose("dave", "let me in");
  assert.ok("error" in result);
  assert.match(String(room.vote("dave", "#1", "yes")), /observers cannot vote/);
});

test("leaving withdraws your pending proposals and unblocks the room", () => {
  const { room } = makeRoom("pair");
  seat(room, "alice");
  seat(room, "bob");
  seat(room, "carol");
  const p = room.propose("carol", "rewrite it in rust") as Proposal;
  room.leave("carol");
  assert.equal(p.status, "withdrawn");
});

test("a departure can complete a consensus that was waiting on the leaver", () => {
  const { room } = makeRoom("pair");
  seat(room, "alice");
  seat(room, "bob");
  seat(room, "carol");
  const p = room.propose("alice", "run the test suite") as Proposal;
  room.vote("bob", p.id, "yes");
  assert.equal(p.status, "open", "still waiting on carol");
  room.leave("carol");
  assert.equal(p.status, "approved");
});

test("the host is reassigned when they leave, oldest first", () => {
  const { room } = makeRoom();
  seat(room, "alice");
  seat(room, "bob");
  seat(room, "carol");
  room.leave("alice");
  assert.equal(room.owner, "bob");
});

test("queued prompts merge into one turn, with attribution", () => {
  const { room } = makeRoom("solo");
  seat(room, "alice");
  seat(room, "bob");
  room.propose("alice", "add a health endpoint");
  room.propose("bob", "and a readiness probe");
  const batch = room.takeQueued();
  assert.equal(batch.length, 2, "mergeQueued bundles them");
  const turn = room.composeTurn(batch);
  assert.match(turn, /\[alice\] add a health endpoint/);
  assert.match(turn, /\[bob\] and a readiness probe/);
});

test("attribution names the approvers, not just the author", () => {
  const { room } = makeRoom("team");
  seat(room, "alice");
  seat(room, "bob");
  seat(room, "carol");
  const p = room.propose("alice", "bump the timeout") as Proposal;
  room.vote("bob", p.id, "yes");
  const turn = room.composeTurn(room.takeQueued());
  assert.match(turn, /\[alice, approved by bob\]/);
});

test("mergeQueued off sends one proposal per turn", () => {
  const policy = resolvePreset("solo")!;
  policy.mergeQueued = false;
  const room = new Room({ name: "t", cwd: "/tmp", policy, transcriptPath: null });
  room.join({ name: "alice", role: "owner", connectionId: "alice" });
  room.propose("alice", "one");
  room.propose("alice", "two");
  assert.equal(room.takeQueued().length, 1);
  assert.equal(room.takeQueued().length, 1);
});

test("tool calls are put to the room and can be denied", async () => {
  const { room } = makeRoom("pair");
  seat(room, "alice");
  seat(room, "bob");

  const decisions: { allow: boolean; reason: string }[] = [];
  room.on("toolDecision", (_p: Proposal, allow: boolean, reason: string) =>
    decisions.push({ allow, reason }),
  );

  const p = room.proposeTool({
    toolUseId: "tu_1",
    name: "bash",
    input: { command: "rm -rf build" },
    risk: "exec",
    summary: "bash: rm -rf build",
  });
  assert.equal(p.status, "open", "an exec tool is not auto-allowed under `pair`");
  room.vote("bob", p.id, "no", "not on my machine");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0]!.allow, false);
  assert.match(decisions[0]!.reason, /not on my machine/);
});

test("only the host can change the policy, and open votes re-evaluate immediately", () => {
  const { room } = makeRoom("strict");
  seat(room, "alice");
  seat(room, "bob");
  seat(room, "carol");
  const p = room.propose("alice", "deploy to staging") as Proposal;
  assert.equal(p.status, "open");

  assert.match(String(room.setPolicy("bob", resolvePreset("solo")!)), /only the host/);
  assert.equal(room.setPolicy("alice", resolvePreset("solo")!), null);
  assert.equal(p.status, "approved", "loosening the rule resolves what was pending");
});

test("proposal handles accept #3, 3, or nothing at all", () => {
  const { room } = makeRoom("strict");
  seat(room, "alice");
  seat(room, "bob");
  room.propose("alice", "first");
  room.propose("alice", "second");
  assert.equal(room.resolveHandle("#1")?.text, "first");
  assert.equal(room.resolveHandle("2")?.text, "second");
  assert.equal(room.resolveHandle("")?.text, "second", "bare vote targets the newest open one");
  assert.equal(room.resolveHandle("#99"), undefined);
});

test("interrupt rights follow the policy", () => {
  const { room } = makeRoom("strict"); // interrupt: owner
  seat(room, "alice");
  seat(room, "bob");
  assert.equal(room.canInterrupt("alice"), true);
  assert.equal(room.canInterrupt("bob"), false);

  const { room: open } = makeRoom("pair"); // interrupt: anyone
  seat(open, "alice");
  seat(open, "bob");
  assert.equal(open.canInterrupt("bob"), true);
});

test("round-robin refuses a prompt from whoever does not hold the mic", () => {
  const { room } = makeRoom("round-robin");
  seat(room, "alice");
  seat(room, "bob");
  assert.equal(room.micHolder()?.name, "alice");
  const denied = room.propose("bob", "my turn?");
  assert.ok("error" in denied);
  assert.match((denied as { error: string }).error, /alice holds the mic/);

  const ok = room.propose("alice", "mine") as Proposal;
  assert.equal(ok.status, "approved");
  assert.equal(room.micHolder()?.name, "bob", "the mic advances after a turn");
});

test("the mic can be handed over explicitly", () => {
  const { room } = makeRoom("round-robin");
  seat(room, "alice");
  seat(room, "bob");
  assert.equal(room.passMic("alice", "bob"), null);
  assert.equal(room.micHolder()?.name, "bob");
  assert.match(String(room.passMic("alice", "nobody")), /no such participant/);
});

test("empty proposals are refused", () => {
  const { room } = makeRoom("solo");
  seat(room, "alice");
  assert.ok("error" in room.propose("alice", "   "));
});

test("a snapshot describes the room well enough to render it", () => {
  const { room } = makeRoom("team");
  seat(room, "alice");
  seat(room, "bob");
  room.propose("alice", "hello");
  const snap = room.snapshot();
  assert.equal(snap.participants.length, 2);
  assert.equal(snap.proposals.length, 1);
  assert.equal(snap.policy.prompt.mode, "majority");
  assert.equal(snap.name, "test");
});

test("closing the room cancels its timers", () => {
  const { room } = makeRoom("pair");
  seat(room, "alice");
  seat(room, "bob");
  room.propose("alice", "pending forever");
  room.close();
  // No assertion beyond "this does not throw and leaves nothing scheduled";
  // an un-cleared timer would keep the process alive and hang the test run.
  assert.ok(true);
});
