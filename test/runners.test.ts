import test from "node:test";
import assert from "node:assert/strict";
import { RoutedBackend } from "../src/server/runners.js";
import { looksLimited, resetsAt, classify } from "../src/agent/limits.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../src/agent/types.js";

/* ---- recognising a spent account -------------------------------- */

test("the phrases these tools actually use are recognised as limits", () => {
  const real = [
    "Claude usage limit reached. Your limit will reset at 3pm.",
    "You've reached your usage limit for this 5-hour window",
    "Error: 429 Too Many Requests",
    "rate limit exceeded, please retry",
    "quota exceeded for this model",
    "Your credit balance is too low to access the API",
    "insufficient quota",
    "the model is overloaded",
  ];
  for (const text of real) assert.equal(looksLimited(text), true, text);
});

test("an ordinary failure is not mistaken for a spent account", () => {
  const notLimits = [
    "SyntaxError: unexpected token",
    "ENOENT: no such file or directory",
    "authentication failed — set ANTHROPIC_API_KEY",
    "the turn failed",
    "connection reset by peer",
    "",
    undefined,
  ];
  for (const text of notLimits) assert.equal(looksLimited(text), false, String(text));
});

test("a reset time is read out of the message when the tool gives one", () => {
  const now = new Date("2026-08-25T10:00:00Z").getTime();
  assert.equal(resetsAt("try again in 30 seconds", now), now + 30_000);
  assert.equal(resetsAt("retry in 5 minutes", now), now + 300_000);
  assert.equal(resetsAt("resets in 2 hours", now), now + 7_200_000);
  assert.equal(resetsAt("Retry-After: 90", now), now + 90_000);
  assert.equal(resetsAt("limit reached, no idea when", now), null);
});

test("a wall-clock reset resolves to the next time it comes round", () => {
  const now = new Date("2026-08-25T10:00:00").getTime();
  const at = resetsAt("your limit will reset at 3pm", now)!;
  assert.equal(new Date(at).getHours(), 15);
  assert.ok(at > now);
  // Already past today, so it means tomorrow.
  const late = new Date("2026-08-25T16:00:00").getTime();
  const tomorrow = resetsAt("resets at 3pm", late)!;
  assert.ok(tomorrow > late);
  assert.equal(new Date(tomorrow).getDate(), new Date(late).getDate() + 1);
});

test("classify only marks results that failed for capacity reasons", () => {
  assert.equal(classify({ stopReason: "end_turn" }).limited, undefined);
  assert.equal(classify({ stopReason: "error", error: "bad flag" }).limited, undefined);
  const hit = classify({ stopReason: "error", error: "usage limit reached, resets in 10 minutes" });
  assert.equal(hit.limited, true);
  assert.ok(hit.until && hit.until > Date.now());
});

/* ---- routing ----------------------------------------------------- */

class Fake implements AgentBackend {
  readonly name: string;
  readonly model = "fake";
  calls: string[] = [];
  /** Fail every turn with this, until cleared. */
  failWith: string | null = null;

  constructor(name: string) {
    this.name = name;
  }
  async send(prompt: string, events: AgentEvents): Promise<TurnResult> {
    this.calls.push(prompt);
    if (this.failWith) return { stopReason: "error", error: this.failWith };
    events.onText(`${this.name} answered`);
    return { stopReason: "end_turn", usage: { output_tokens: 1 } };
  }
  async close(): Promise<void> {}
}

function sink(): AgentEvents & { text: string[]; notices: string[] } {
  const text: string[] = [];
  const notices: string[] = [];
  return {
    text,
    notices,
    onText: (s) => text.push(s),
    onThinking: () => {},
    onToolRequest: async () => ({ allow: true, reason: "" }),
    onToolResult: () => {},
    onNotice: (n) => notices.push(n),
  };
}

interface Sent {
  runnerId: string;
  turnId: string;
  prompt: string;
}

function routed(now = () => Date.now()) {
  const sent: Sent[] = [];
  const cancelled: string[] = [];
  const notices: string[] = [];
  const backend = new RoutedBackend({
    dispatch: {
      start: (runnerId, turnId, prompt) => sent.push({ runnerId, turnId, prompt }),
      cancel: (_r, turnId) => cancelled.push(turnId),
    },
    onChange: () => {},
    onNotice: (t) => notices.push(t),
    now,
  });
  return { backend, sent, cancelled, notices };
}

test("the room stays on one runner while it keeps working", async () => {
  const { backend } = routed();
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");

  const s = sink();
  await backend.send("one", s, new AbortController().signal);
  await backend.send("two", s, new AbortController().signal);

  assert.deepEqual(local.calls, ["one", "two"], "no handoff, no recap");
  assert.equal(backend.active, "local");
  assert.equal(backend.list()[0]!.turns, 2);
});

test("a spent account hands the turn to someone else's subscription", async () => {
  const { backend, sent, notices } = routed();
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");
  backend.add("p_bob", "bob", "claude-code", "/home/bob/repo");

  local.failWith = "Claude usage limit reached. Your limit will reset at 3pm.";
  const s = sink();
  const turn = backend.send("keep going", s, new AbortController().signal);

  // The host failed, so the turn was dispatched to bob instead.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.runnerId, "p_bob");

  backend.onOut("p_bob", sent[0]!.turnId, "text", "bob's session answered");
  backend.onEnd("p_bob", sent[0]!.turnId, { stopReason: "end_turn", usage: { output_tokens: 2 } });

  const result = await turn;
  assert.equal(result.stopReason, "end_turn");
  assert.equal(s.text.join(""), "bob's session answered");
  assert.ok(notices.some((n) => /out of capacity/.test(n)));
  assert.ok(notices.some((n) => /3:00|15:00|until/i.test(n)), "the reset time is passed on");

  const roster = backend.list();
  assert.equal(roster.find((r) => r.id === "local")!.exhausted, true);
  assert.equal(backend.active, "p_bob");
});

test("the handoff carries the conversation, and says what was lost", async () => {
  const { backend, sent } = routed();
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");
  backend.add("p_bob", "bob", "codex", "/home/bob/repo");

  const s = sink();
  await backend.send("add retries to the http client", s, new AbortController().signal);

  local.failWith = "usage limit reached";
  const turn = backend.send("now add a test for it", s, new AbortController().signal);
  await new Promise((r) => setTimeout(r, 20));

  const handed = sent[0]!.prompt;
  assert.match(handed, /\[Session handoff\]/);
  assert.match(handed, /add retries to the http client/, "the earlier ask is carried across");
  assert.match(handed, /host-cli answered/, "so is what it replied");
  assert.match(handed, /do not have the previous session's tool results/i, "and the model is told what it lost");
  assert.ok(handed.trimEnd().endsWith("now add a test for it"), "the new ask comes last");

  backend.onEnd("p_bob", sent[0]!.turnId, { stopReason: "end_turn" });
  await turn;
});

test("a plain bug does not burn through everyone's account", async () => {
  const { backend, sent } = routed();
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");
  backend.add("p_bob", "bob", "codex", "/home/bob");

  local.failWith = "SyntaxError: unexpected token in config";
  const result = await backend.send("go", sink(), new AbortController().signal);

  assert.equal(result.stopReason, "error");
  assert.match(String(result.error), /SyntaxError/);
  assert.equal(sent.length, 0, "bob was never asked — the failure was not about capacity");
  assert.equal(backend.list().find((r) => r.id === "local")!.exhausted, false);
});

test("when everyone is spent, the room is told plainly", async () => {
  const { backend, sent } = routed();
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");
  backend.add("p_bob", "bob", "codex", "/home/bob");

  local.failWith = "usage limit reached";
  const turn = backend.send("go", sink(), new AbortController().signal);
  await new Promise((r) => setTimeout(r, 20));
  backend.onEnd("p_bob", sent[0]!.turnId, { stopReason: "error", error: "rate limit exceeded" });

  const result = await turn;
  assert.match(String(result.error), /every account in the room is out of capacity/);
});

test("a limit with a known reset expires on its own", async () => {
  let clock = 1_000_000;
  const { backend } = routed(() => clock);
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");
  backend.add("p_bob", "bob", "codex", "/home/bob");

  local.failWith = "usage limit reached, try again in 10 minutes";
  const turn = backend.send("go", sink(), new AbortController().signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(backend.list().find((r) => r.id === "local")!.exhausted, true);

  clock += 11 * 60_000;
  assert.equal(backend.list().find((r) => r.id === "local")!.exhausted, false, "the window passed");
  void turn;
});

test("a runner that leaves mid-turn does not hang the room", async () => {
  const { backend, sent } = routed();
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");
  backend.add("p_bob", "bob", "codex", "/home/bob");

  local.failWith = "usage limit reached";
  const turn = backend.send("go", sink(), new AbortController().signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.length, 1);

  backend.remove("p_bob");
  const result = await turn;
  assert.match(String(result.error), /out of capacity|left while running/);
});

test("output from a runner we are not waiting on is ignored", async () => {
  const { backend, sent } = routed();
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");
  backend.add("p_bob", "bob", "codex", "/home/bob");
  local.failWith = "usage limit reached";

  const s = sink();
  const turn = backend.send("go", s, new AbortController().signal);
  await new Promise((r) => setTimeout(r, 20));

  backend.onOut("p_mallory", sent[0]!.turnId, "text", "injected");
  backend.onOut("p_bob", "some-other-turn", "text", "stale");
  backend.onOut("p_bob", sent[0]!.turnId, "text", "legitimate");
  backend.onEnd("p_bob", sent[0]!.turnId, { stopReason: "end_turn" });

  await turn;
  assert.equal(s.text.join(""), "legitimate");
});

test("interrupting a remote turn cancels it on that runner", async () => {
  const { backend, sent, cancelled } = routed();
  const local = new Fake("host-cli");
  backend.addLocal("alice", local, "/repo");
  backend.add("p_bob", "bob", "codex", "/home/bob");
  local.failWith = "usage limit reached";

  const ac = new AbortController();
  const turn = backend.send("go", sink(), ac.signal);
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();

  const result = await turn;
  assert.equal(result.stopReason, "interrupted");
  assert.deepEqual(cancelled, [sent[0]!.turnId]);
});

test("the roster shows whose account is carrying the room", () => {
  const { backend } = routed();
  backend.addLocal("alice", new Fake("claude-code"), "/repo");
  backend.add("p_bob", "bob", "codex", "/home/bob/repo");

  const roster = backend.list();
  assert.equal(roster.length, 2);
  assert.equal(roster[0]!.local, true, "the host is listed first");
  assert.equal(roster[0]!.name, "alice");
  assert.equal(roster[1]!.cwd, "/home/bob/repo", "each runner's own directory is visible");
  assert.ok(!("backendRef" in roster[0]!), "the roster never leaks a backend handle");
});
