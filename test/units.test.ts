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

/* ---- what lands on disk ------------------------------------------ */

/**
 * The transcript is the room in plain text — proposals, veto reasons, chat, and
 * whatever the model said, which includes whatever it read out of the
 * repository. It used to be written at the umask default, so on a shared
 * machine every account could read every session.
 */
test("the transcript is written for its owner only", async () => {
  const { mkdtempSync, statSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "mpx-perm-"));
  const path = join(dir, ".mpx", "room.jsonl");

  const t = new Transcript(path);
  t.write({ t: "chat", fromId: "a", fromName: "alice", text: "secret", at: Date.now() });
  await new Promise((r) => setTimeout(r, 60));

  // Windows does not carry these bits; the mode there is not meaningful.
  if (process.platform === "win32") return;
  assert.equal(statSync(path).mode & 0o777, 0o600, "the transcript must not be world-readable");
  assert.equal(statSync(join(dir, ".mpx")).mode & 0o777, 0o700, "nor the directory holding it");
});

/* ---- tool path containment ------------------------------------- */

/**
 * `safePath` used to be a purely lexical check while its comment claimed
 * "symlinks included". `resolve` does not follow links, so a link inside the
 * room was a lexically innocent path and both reads and writes went straight
 * through it to anywhere on disk — un-voted, since `read` is auto-allowed in
 * every preset but `strict`.
 */
test("a symlink out of the working directory is refused, for reads and writes", async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } = await import("node:fs");
  const outside = mkdtempSync(join(tmpdir(), "mpx-outside-"));
  writeFileSync(join(outside, "secret.txt"), "private\n");

  const room = mkdtempSync(join(tmpdir(), "mpx-room-"));
  mkdirSync(join(room, "sub"));
  symlinkSync(outside, join(room, "sub", "elsewhere"));

  const read = await runTool(room, "read_file", { path: "sub/elsewhere/secret.txt" });
  assert.equal(read.ok, false, "reading through a symlink must not escape the room");
  assert.match(read.content, /escapes/);

  const wrote = await runTool(room, "write_file", { path: "sub/elsewhere/planted.txt", content: "x" });
  assert.equal(wrote.ok, false, "writing through a symlink must not escape the room either");

  const found = await runTool(room, "search", { pattern: "private" });
  assert.ok(!found.content.includes("private"), "the walker must not read through symlinks either");
});

test("the plain traversals stay refused", async () => {
  const { mkdtempSync } = await import("node:fs");
  const room = mkdtempSync(join(tmpdir(), "mpx-room-"));
  for (const path of ["../../etc/hostname", "/etc/hostname"]) {
    const r = await runTool(room, "read_file", { path });
    assert.equal(r.ok, false, `${path} must be refused`);
  }
});

/**
 * The two cases a naive realpath fix breaks: a link that stays inside the room,
 * and a room whose own cwd is reached through one (which /tmp is, on macOS).
 */
test("legitimate paths still resolve, including links that stay inside", async () => {
  const { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } = await import("node:fs");
  const real = mkdtempSync(join(tmpdir(), "mpx-real-"));
  mkdirSync(join(real, "src"));
  writeFileSync(join(real, "src", "app.ts"), "export const x = 1;\n");
  symlinkSync(join(real, "src"), join(real, "linked"));

  assert.equal((await runTool(real, "read_file", { path: "src/app.ts" })).ok, true);
  assert.equal((await runTool(real, "read_file", { path: "linked/app.ts" })).ok, true);
  assert.equal((await runTool(real, "write_file", { path: "src/fresh.ts", content: "ok" })).ok, true);

  const viaLink = join(mkdtempSync(join(tmpdir(), "mpx-via-")), "room");
  symlinkSync(real, viaLink);
  assert.equal(
    (await runTool(viaLink, "read_file", { path: "src/app.ts" })).ok,
    true,
    "a cwd reached through a symlink must still be able to read its own files",
  );
});

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
  assert.ok(helpLines().some((l) => l.includes("proposal")));
});

test("a bare /help shows what you need, not everything there is", () => {
  const short = helpLines();
  const all = helpLines(true);

  // The point of the tiering: meeting the room should not mean meeting the
  // feature list. If this ever inverts, someone has quietly promoted a command.
  assert.ok(short.length < all.length / 2, `short list is ${short.length} of ${all.length}`);

  for (const feature of ["/race", "/split", "/lanes", "/policy", "/mic", "/ask", "/fork", "/amend"]) {
    assert.ok(
      !short.some((l) => l.startsWith(feature)),
      `${feature} should wait until someone asks for it`,
    );
    assert.ok(all.some((l) => l.startsWith(feature)), `${feature} is missing from /help all`);
  }

  // What is left has to be enough to take part at all.
  for (const need of ["/y", "/n", "/say", "/stop", "/who", "/queue", "/help", "/quit"]) {
    assert.ok(short.some((l) => l.startsWith(need + " ") || l.startsWith(need + "\n") || l === need), need);
  }
});

test("the short list says where the rest is, and the long one does not repeat itself", () => {
  // A person who cannot find the rest concludes there is no rest.
  assert.ok(helpLines().some((l) => l.startsWith("/help all")), "the way out is named");
  assert.equal(
    helpLines(true).filter((l) => l.startsWith("/help all")).length,
    0,
    "no dangling pointer once you are already looking at everything",
  );
});

test("aliases are held back until the long list", () => {
  // Four ways to say yes is a kindness once you are using the thing and noise
  // while you are learning what it does.
  assert.ok(!helpLines().some((l) => l.includes("/approve")));
  assert.ok(helpLines(true).some((l) => l.includes("/approve")));
});

test("/help all is what asks for the long list", () => {
  assert.deepEqual(parse("/help", ctx), { kind: "local", action: "help" });
  assert.deepEqual(parse("/help all", ctx), { kind: "local", action: "help", arg: "all" });
  // Anything else after /help is not a request for everything.
  assert.deepEqual(parse("/help race", ctx), { kind: "local", action: "help" });
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

test("the version mpx reports is the version in the manifest", async () => {
  // These were two hand-maintained copies of the same number, and they spent
  // two releases disagreeing.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { readFileSync } = await import("node:fs");
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const { stdout } = await promisify(execFile)(process.execPath, [
    new URL("../src/cli.js", import.meta.url).pathname,
    "--version",
  ]);
  assert.equal(stdout.trim(), manifest.version);
});
