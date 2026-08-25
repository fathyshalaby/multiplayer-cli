import test from "node:test";
import assert from "node:assert/strict";
import { RoomView } from "../src/client/roomView.js";
import { panelHtml } from "../src/client/editorPanel.js";
import type { Participant, Proposal, ServerMessage, Tally } from "../src/protocol.js";
import { resolvePreset } from "../src/core/policy.js";

/**
 * The editor seat's view model. This is where the behaviour worth testing
 * lives — the VS Code glue around it is thin, and none of this needs an editor
 * to exercise.
 */

function person(id: string, name: string, role: Participant["role"] = "member"): Participant {
  return { id, name, color: 0, role, joinedAt: 0, connected: true, typing: false };
}

function proposal(id: string, over: Partial<Proposal> = {}): Proposal {
  return {
    id,
    kind: "prompt",
    authorId: "p_alice",
    authorName: "alice",
    text: "refactor the auth middleware",
    createdAt: 0,
    deadline: null,
    votes: {},
    edits: [],
    status: "open",
    ...over,
  };
}

const tally: Tally = { yes: 1, no: 0, abstain: 0, pending: ["p_bob"], electorate: 2, need: 1, decision: "pending", reason: "" };

function snapshotMsg(): ServerMessage {
  return {
    t: "welcome",
    you: person("p_me", "me"),
    room: {
      roomId: "r1",
      name: "amber-ridge-04",
      cwd: "/work/api",
      policy: resolvePreset("team")!,
      participants: [person("p_alice", "alice", "owner"), person("p_me", "me")],
      proposals: [],
      agent: { state: "idle", turnId: null, model: "", backend: "claude-code" },
      queued: [],
      micHolderId: null,
      transcriptPath: null,
      turnCount: 0,
      runners: [],
      activeRunnerId: null,
    },
  };
}

test("a welcome fills in everything the panel needs to draw", () => {
  const v = new RoomView(() => 1000);
  v.setConnected(true, true);
  v.apply(snapshotMsg());
  const s = v.snapshot();

  assert.equal(s.room, "amber-ridge-04");
  assert.equal(s.backend, "claude-code");
  assert.equal(s.cwd, "/work/api");
  assert.equal(s.gate, "majority+veto 45s");
  assert.equal(s.youName, "me");
  assert.equal(s.participants.length, 2);
  assert.equal(s.encrypted, true);
});

test("streamed output accumulates into one reply, not one entry per token", () => {
  const v = new RoomView(() => 0);
  v.apply({ t: "turnStart", turnId: "t1", prompt: "p", contributors: ["alice"] });
  for (const chunk of ["Here ", "is ", "the ", "patch."]) {
    v.apply({ t: "delta", turnId: "t1", kind: "text", text: chunk });
  }
  const model = v.snapshot().log.filter((e) => e.kind === "model");
  assert.equal(model.length, 1);
  assert.equal(model[0]!.text, "Here is the patch.");
});

test("a second turn starts a new reply rather than appending to the first", () => {
  const v = new RoomView(() => 0);
  v.apply({ t: "delta", turnId: "t1", kind: "text", text: "first" });
  v.apply({ t: "turnEnd", turnId: "t1", stopReason: "end_turn" });
  v.apply({ t: "delta", turnId: "t2", kind: "text", text: "second" });
  const model = v.snapshot().log.filter((e) => e.kind === "model");
  assert.deepEqual(model.map((m) => m.text), ["first", "second"]);
});

test("thinking deltas are not shown as the reply", () => {
  const v = new RoomView(() => 0);
  v.apply({ t: "delta", turnId: "t1", kind: "thinking", text: "hmm" });
  assert.equal(v.snapshot().log.filter((e) => e.kind === "model").length, 0);
});

test("an open proposal carries a progress line; a resolved one carries its reason", () => {
  const v = new RoomView(() => 5_000);
  v.apply({ t: "proposal", proposal: proposal("#1", { deadline: 20_000 }), tally, event: "new" });
  let card = v.snapshot().proposals[0]!;
  assert.equal(card.open, true);
  assert.match(card.progress, /1\/2 ✓/);
  assert.match(card.progress, /15s left/);

  v.apply({
    t: "resolved",
    proposal: proposal("#1", { status: "rejected", resolution: "vetoed: not on prod" }),
    tally: { ...tally, decision: "reject" },
  });
  card = v.snapshot().proposals[0]!;
  assert.equal(card.open, false);
  assert.match(card.progress, /rejected — vetoed: not on prod/);
  assert.equal(v.snapshot().proposals.length, 1, "the card is replaced, not duplicated");
});

test("a bare approve targets the newest open proposal", () => {
  const v = new RoomView(() => 0);
  assert.equal(v.defaultProposalId(), null);
  v.apply({ t: "proposal", proposal: proposal("#1"), tally, event: "new" });
  v.apply({ t: "proposal", proposal: proposal("#2"), tally, event: "new" });
  assert.equal(v.defaultProposalId(), "#2");

  v.apply({ t: "resolved", proposal: proposal("#2", { status: "approved" }), tally });
  assert.equal(v.defaultProposalId(), "#1", "a resolved one is no longer a target");
});

test("a tool vote outranks a prompt, because it is blocking the session", () => {
  const v = new RoomView(() => 0);
  v.apply({ t: "proposal", proposal: proposal("#1"), tally, event: "new" });
  v.apply({
    t: "proposal",
    proposal: proposal("#2", {
      kind: "tool",
      authorId: "agent",
      authorName: "claude",
      text: "bash: rm -rf build",
      tool: { toolUseId: "t", name: "bash", input: {}, risk: "exec", summary: "bash: rm -rf build" },
    }),
    tally,
    event: "new",
  });
  v.apply({ t: "proposal", proposal: proposal("#3"), tally, event: "new" });
  assert.equal(v.defaultProposalId(), "#2");
});

test("chat keeps the speaker's identity and colour", () => {
  const v = new RoomView(() => 0);
  v.apply(snapshotMsg());
  v.apply({ t: "chat", fromId: "p_alice", fromName: "alice", text: "should we even ask this?", at: 7 });
  const chat = v.snapshot().log.filter((e) => e.kind === "chat")[0]!;
  assert.equal(chat.who, "alice");
  assert.equal(chat.text, "should we even ask this?");
});

test("presence, policy changes and errors all surface as notices", () => {
  const v = new RoomView(() => 0);
  v.apply({ t: "presence", participants: [person("p_bob", "bob")], joined: "bob" });
  v.apply({ t: "policy", policy: resolvePreset("strict")!, byName: "alice" });
  v.apply({ t: "error", text: "only the host can change the policy" });

  const text = v.snapshot().log.map((e) => e.text).join(" | ");
  assert.match(text, /bob joined/);
  assert.match(text, /alice changed the room's rules/);
  assert.match(text, /only the host/);
  assert.equal(v.snapshot().gate, "consensus", "and the gate is updated, not just announced");
});

test("the status bar says what is waiting on you", () => {
  const v = new RoomView(() => 0);
  assert.match(v.statusText(), /circle-slash/);

  v.setConnected(true, true);
  v.apply(snapshotMsg());
  assert.match(v.statusText(), /amber-ridge-04/);

  v.apply({ t: "proposal", proposal: proposal("#1"), tally, event: "new" });
  assert.match(v.statusText(), /1 pending/);

  v.apply({ t: "resolved", proposal: proposal("#1", { status: "approved" }), tally });
  v.apply({ t: "agent", status: { state: "streaming", turnId: "t", model: "", backend: "claude-code" } });
  assert.match(v.statusText(), /streaming/);
});

test("the log does not grow without bound", () => {
  const v = new RoomView(() => 0);
  for (let i = 0; i < 2000; i++) v.apply({ t: "notice", level: "info", text: `line ${i}` });
  const log = v.snapshot().log;
  assert.ok(log.length <= 400, `kept ${log.length}`);
  assert.match(log[log.length - 1]!.text, /line 1999/, "and keeps the newest");
});

test("leaving resets the view rather than leaving a stale room on screen", () => {
  const v = new RoomView(() => 0);
  v.setConnected(true, true);
  v.apply(snapshotMsg());
  v.apply({ t: "proposal", proposal: proposal("#1"), tally, event: "new" });
  v.reset();
  const s = v.snapshot();
  assert.equal(s.room, "");
  assert.equal(s.proposals.length, 0);
  assert.equal(s.connected, false);
  assert.equal(v.defaultProposalId(), null);
});

test("the panel is self-contained and declares a strict policy", () => {
  const html = panelHtml();
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.ok(!/<script[^>]+\bsrc\s*=/i.test(html), "no remote scripts");
  assert.ok(!/\bfetch\s*\(/.test(html), "the panel never talks to the network itself");
  assert.ok(html.includes("acquireVsCodeApi"), "it talks to the extension host instead");
  assert.ok(html.includes("var(--vscode-"), "and uses the editor's own theme");
});

/* ---- the bundle itself ------------------------------------------- */

import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { createRequire } from "node:module";
import { sessionPage } from "../src/server/web.js";

/**
 * Loading the built extension is the only way to catch the class of bug that
 * bit here: `import.meta.url` is undefined once esbuild emits CommonJS, so a
 * module resolving its own path at import time threw and the extension would
 * never have activated. A typecheck cannot see that; a require can.
 */
test("the built extension loads and activates with a stubbed editor", (t) => {
  const bundle = resolvePath("extension/dist/extension.js");
  if (!existsSync(bundle)) {
    t.skip("extension not built — run `node scripts/build-extension.mjs`");
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), "mpx-ext-"));
  mkdirSync(join(dir, "node_modules", "vscode"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "vscode", "package.json"),
    JSON.stringify({ name: "vscode", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(
    join(dir, "node_modules", "vscode", "index.js"),
    `const noop = () => {};
     const disposable = { dispose: noop };
     module.exports = {
       StatusBarAlignment: { Left: 1, Right: 2 },
       Uri: { file: (p) => ({ fsPath: p }) },
       window: {
         createStatusBarItem: () => ({ show: noop, dispose: noop, text: "", tooltip: "", command: "" }),
         registerWebviewViewProvider: () => disposable,
         showInformationMessage: noop, showWarningMessage: noop, showErrorMessage: noop,
         showInputBox: async () => undefined,
       },
       commands: { registerCommand: () => disposable, executeCommand: async () => {} },
       workspace: { workspaceFolders: [], getConfiguration: () => ({ get: () => "" }) },
       env: { clipboard: { writeText: async () => {} } },
     };`,
  );
  copyFileSync(bundle, join(dir, "extension.cjs"));

  const req = createRequire(join(dir, "noop.cjs"));
  const ext = req("./extension.cjs") as {
    activate?: (c: unknown) => void;
    deactivate?: () => void;
  };

  assert.equal(typeof ext.activate, "function", "VS Code needs an activate export");
  assert.equal(typeof ext.deactivate, "function");

  const subscriptions: unknown[] = [];
  ext.activate!({ subscriptions, extensionUri: { fsPath: dir } });
  assert.ok(subscriptions.length > 5, `registered ${subscriptions.length} disposables`);
  ext.deactivate!();
});

test("the browser seat is found however this is packaged", () => {
  // Bundled builds resolve it next to the bundle rather than by module URL.
  const html = sessionPage();
  assert.match(html, /<!doctype html>/i);
  assert.ok(existsSync("extension/dist/session.html") || existsSync("dist/src/client/web/session.html"));
});
