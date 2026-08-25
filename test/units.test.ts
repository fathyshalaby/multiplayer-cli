import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Room } from "../src/core/room.js";
import { resolvePreset } from "../src/core/policy.js";
import { Transcript, readTranscript } from "../src/core/transcript.js";
import { parse, helpLines } from "../src/client/commands.js";
import { decode, encode, PROTOCOL_VERSION } from "../src/protocol.js";
import { parseArgs, str, num, bool } from "../src/util/args.js";
import { riskOf, summarize, runTool } from "../src/agent/tools.js";
import { wrapText, truncate, stripAnsi } from "../src/util/ansi.js";
import type { Proposal } from "../src/protocol.js";

/* ---- commands ---------------------------------------------------- */

const ctx = { defaultProposal: () => "#7" };

test("bare text is a proposal, not a chat message", () => {
  const r = parse("make the tests pass", ctx);
  assert.equal(r.kind, "send");
  assert.deepEqual(r.kind === "send" ? r.msg : null, { t: "propose", text: "make the tests pass" });
});

test("/y targets the newest open proposal when no handle is given", () => {
  const r = parse("/y", ctx);
  assert.deepEqual(r.kind === "send" ? r.msg : null, { t: "vote", proposalId: "#7", vote: "yes" });
});

test("/n takes an id and a reason, in either combination", () => {
  assert.deepEqual(
    parse("/n #3 too risky", ctx).kind === "send" ? (parse("/n #3 too risky", ctx) as any).msg : null,
    { t: "vote", proposalId: "#3", vote: "no", comment: "too risky" },
  );
  assert.deepEqual(
    (parse("/n too risky", ctx) as any).msg,
    { t: "vote", proposalId: "#7", vote: "no", comment: "too risky" },
  );
  assert.deepEqual((parse("/veto 3", ctx) as any).msg, { t: "vote", proposalId: "#3", vote: "no" });
});

test("/amend needs replacement text", () => {
  assert.equal(parse("/amend #2", ctx).kind, "error");
  assert.deepEqual((parse("/amend 2 do it safely", ctx) as any).msg, {
    t: "amend",
    proposalId: "#2",
    text: "do it safely",
  });
});

test("/policy with no arguments shows, with arguments sets", () => {
  assert.deepEqual(parse("/policy", ctx), { kind: "local", action: "policy" });
  const set = parse("/policy team timeout=30s veto=true", ctx) as any;
  assert.deepEqual(set.msg.patch, { preset: "team", overrides: ["timeout=30s", "veto=true"] });
  const noPreset = parse("/policy mode=consensus", ctx) as any;
  assert.equal(noPreset.msg.patch.preset, undefined);
});

test("unknown commands are reported, not sent as prompts", () => {
  const r = parse("/frobnicate", ctx);
  assert.equal(r.kind, "error");
  assert.match(r.kind === "error" ? r.text : "", /unknown command/);
});

test("aliases resolve and help documents every command", () => {
  for (const alias of ["/yes", "/ok", "/approve", "/+1"]) {
    assert.equal((parse(alias, ctx) as any).msg.vote, "yes", alias);
  }
  assert.ok(helpLines().length > 10);
  assert.ok(helpLines().some((l) => l.includes("proposal")));
});

test("empty input does nothing at all", () => {
  assert.equal(parse("   ", ctx).kind, "noop");
});

/* ---- protocol ---------------------------------------------------- */

test("frames round-trip and garbage is rejected without throwing", () => {
  const msg = { t: "hello", name: "alice", protocol: PROTOCOL_VERSION } as const;
  assert.deepEqual(decode(encode(msg)), msg);
  assert.equal(decode("not json"), null);
  assert.equal(decode("[1,2,3]"), null);
  assert.equal(decode('{"no":"tag"}'), null);
});

/* ---- argv -------------------------------------------------------- */

test("argv parsing covers the shapes documented in --help", () => {
  const p = parseArgs(["host", "--policy", "team", "--port=9000", "--open", "--no-transcript", "--set", "mode=quorum"]);
  assert.equal(p.command, "host");
  assert.equal(str(p, "policy", "x"), "team");
  assert.equal(num(p, "port", 1), 9000);
  assert.equal(bool(p, "open", false), true);
  assert.equal(bool(p, "transcript", true), false);
  assert.equal(str(p, "set", ""), "mode=quorum");
});

/* ---- the early-timer regression ---------------------------------- */

test("a vote timer that fires early re-arms instead of hanging the proposal", async () => {
  const policy = resolvePreset("pair")!;
  policy.prompt.autoApproveMs = 40;
  // A clock that lags real time makes every timer fire "early" from the room's
  // point of view — exactly the condition that used to strand a proposal.
  const room = new Room({ name: "t", cwd: "/tmp", policy, now: () => Date.now() - 15 });
  room.join({ name: "alice", role: "owner", connectionId: "alice" });
  room.join({ name: "bob", role: "member", connectionId: "bob" });

  const p = room.propose("alice", "silence means yes") as Proposal;
  assert.equal(p.status, "open");

  await new Promise((r) => setTimeout(r, 300));
  assert.equal(p.status, "approved", "the timer must eventually decide");
  room.close();
});

/* ---- transcript -------------------------------------------------- */

test("the transcript records decisions and coalesces streamed text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-"));
  const path = join(dir, "session.jsonl");
  const tx = new Transcript(path);

  tx.write({ t: "chat", fromId: "a", fromName: "alice", text: "hey", at: 1 });
  tx.write({ t: "delta", turnId: "t1", kind: "text", text: "hel" });
  tx.write({ t: "delta", turnId: "t1", kind: "text", text: "lo" });
  tx.write({ t: "delta", turnId: "t1", kind: "thinking", text: "hmm" });
  tx.write({ t: "turnEnd", turnId: "t1", stopReason: "end_turn" });
  await tx.close();

  const entries = await readTranscript(path);
  const deltas = entries.filter((e) => e.msg.t === "delta");
  assert.equal(deltas.length, 1, "one line per turn, not one per token");
  assert.equal((deltas[0]!.msg as any).text, "hello");
  assert.ok(entries.some((e) => e.msg.t === "chat"));
  assert.ok(entries.some((e) => e.msg.t === "turnEnd"));
});

test("a torn final line does not break transcript replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-"));
  const path = join(dir, "torn.jsonl");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, '{"at":1,"msg":{"t":"pong"}}\n{"at":2,"msg":{"t":"po');
  const entries = await readTranscript(path);
  assert.equal(entries.length, 1);
});

test("transcripts are optional", async () => {
  const tx = new Transcript(null);
  tx.write({ t: "notice", level: "info", text: "no file, no crash" });
  await tx.close();
  assert.ok(true);
});

/* ---- tools ------------------------------------------------------- */

test("tool risk classification fails closed for anything unrecognised", () => {
  assert.equal(riskOf("read_file"), "read");
  assert.equal(riskOf("write_file"), "write");
  assert.equal(riskOf("bash"), "exec");
  assert.equal(riskOf("launch_missiles"), "exec", "unknown tools are treated as dangerous");
});

test("tool summaries are short enough to vote on", () => {
  assert.equal(summarize("bash", { command: "rm -rf build\nmore" }), "bash: rm -rf build");
  assert.equal(summarize("read_file", { path: "src/a.ts" }), "read src/a.ts");
  assert.match(summarize("write_file", { path: "a.ts", content: "xy" }), /write a\.ts \(2 bytes\)/);
});

test("tools cannot read outside the room's working directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-"));
  const escape = await runTool(dir, "read_file", { path: "../../../etc/passwd" });
  assert.equal(escape.ok, false);
  assert.match(escape.content, /escapes/);

  const abs = await runTool(dir, "read_file", { path: "/etc/passwd" });
  assert.equal(abs.ok, false);
});

test("tools do the ordinary thing inside the directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-"));
  const w = await runTool(dir, "write_file", { path: "note.txt", content: "alpha\nbeta\n" });
  assert.equal(w.ok, true);
  const r = await runTool(dir, "read_file", { path: "note.txt" });
  assert.match(r.content, /alpha/);
  const l = await runTool(dir, "list_dir", { path: "." });
  assert.match(l.content, /note\.txt/);
  const s = await runTool(dir, "search", { pattern: "bet[a]" });
  assert.match(s.content, /note\.txt:2/);
  const b = await runTool(dir, "bash", { command: "echo ran-here" });
  assert.equal(b.ok, true);
  assert.match(b.content, /ran-here/);
});

test("a failing command reports failure rather than pretending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-"));
  const b = await runTool(dir, "bash", { command: "exit 3" });
  assert.equal(b.ok, false);
  assert.match(b.content, /exit 3/);
});

test("unknown tools are refused", async () => {
  const out = await runTool(process.cwd(), "nope", {});
  assert.equal(out.ok, false);
});

/* ---- text helpers ------------------------------------------------ */

test("text wrapping keeps paragraphs and respects the width", () => {
  const lines = wrapText("one two three four five six seven", 12, "  ");
  assert.ok(lines.every((l) => stripAnsi(l).length <= 14));
  assert.ok(lines.every((l) => l.startsWith("  ")));
  assert.deepEqual(wrapText("a\nb", 40), ["a", "b"]);
});

test("truncation is measured in visible characters", () => {
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 10), "abc");
});
