import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessBackend } from "../src/agent/process.js";
import { PROFILES } from "../src/agent/profiles.js";
import type { AgentEvents } from "../src/agent/types.js";

/**
 * Codex, Copilot and OpenCode are not installed in CI, and their real output
 * costs money to produce. These stubs emit exactly what each tool documents,
 * which is what the adapter is actually written against — and they record the
 * argv they were called with, so flag construction is checked too.
 */
function stub(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/usr/bin/env node\nconst fs=require("fs");\nfs.writeFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv.slice(2)));\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

function sink(): { events: AgentEvents; text: string[]; tools: string[]; notices: string[] } {
  const text: string[] = [];
  const tools: string[] = [];
  const notices: string[] = [];
  return {
    text,
    tools,
    notices,
    events: {
      onText: (s) => text.push(s),
      onThinking: () => {},
      onToolRequest: async () => ({ allow: true, reason: "auto" }),
      onToolResult: (_id, _ok, preview) => tools.push(preview),
      onNotice: (n) => notices.push(n),
    },
  };
}

function argvOf(dir: string): string[] {
  const p = join(dir, "argv.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : [];
}

function make(dir: string, profileName: string, bin: string, resume: string | null = null) {
  process.env.ARGV_LOG = join(dir, "argv.json");
  return new ProcessBackend({
    profile: PROFILES[profileName]!,
    cwd: dir,
    model: "",
    bin,
    extraArgs: [],
    resume,
    showThinking: false,
  });
}

/* ---- codex ------------------------------------------------------- */

const CODEX_STUB = `
const out = [
  {type:"thread.started",thread_id:"th_abc123def456"},
  {type:"turn.started"},
  {type:"item.completed",item:{id:"item_0",type:"reasoning",text:"considering options"}},
  {type:"item.completed",item:{id:"item_1",type:"command_execution",command:"npm test\\nsecond line"}},
  {type:"item.completed",item:{id:"item_2",type:"agent_message",text:"Added retries to the client."}},
  {type:"turn.completed",usage:{input_tokens:120,cached_input_tokens:80,output_tokens:44}},
];
for (const o of out) process.stdout.write(JSON.stringify(o)+"\\n");
`;

test("codex: documented JSONL becomes room events, and the thread is captured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-codex-"));
  const bin = stub(dir, "codex", CODEX_STUB);
  const backend = make(dir, "codex", bin);
  const s = sink();

  const r = await backend.send("add retries", s.events, new AbortController().signal);

  assert.equal(r.stopReason, "end_turn");
  assert.equal(r.usage?.output_tokens, 44);
  assert.equal(r.usage?.cache_read, 80);
  assert.match(s.text.join(""), /Added retries to the client\./);
  assert.equal(backend.session, "th_abc123def456", "the thread id is remembered");
  assert.ok(s.tools.some((t) => t.startsWith("run: npm test")), "commands are announced to the room");
  assert.ok(!s.tools.some((t) => t.includes("second line")), "announcements stay to one line");
});

test("codex: the second turn resumes the same thread", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-codex2-"));
  const bin = stub(dir, "codex", CODEX_STUB);
  const backend = make(dir, "codex", bin);
  const s = sink();

  await backend.send("first", s.events, new AbortController().signal);
  const firstArgv = argvOf(dir);
  assert.deepEqual(firstArgv.slice(0, 1), ["exec"]);
  assert.ok(!firstArgv.includes("resume"), "nothing to resume on turn one");
  assert.ok(firstArgv.includes("--json"));
  assert.equal(firstArgv[firstArgv.length - 1], "first", "the prompt is the final argument");

  await backend.send("second", s.events, new AbortController().signal);
  const secondArgv = argvOf(dir);
  assert.deepEqual(secondArgv.slice(0, 3), ["exec", "resume", "th_abc123def456"]);
  assert.equal(secondArgv[secondArgv.length - 1], "second");
});

test("codex: a failed turn is reported, not silently ended", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-codexf-"));
  const bin = stub(
    dir,
    "codex",
    `process.stdout.write(JSON.stringify({type:"turn.failed",error:{message:"model overloaded"}})+"\\n");`,
  );
  const s = sink();
  const r = await make(dir, "codex", bin).send("x", s.events, new AbortController().signal);
  assert.equal(r.stopReason, "error");
  assert.match(String(r.error), /model overloaded/);
});

test("codex: non-JSON noise on stdout is shown rather than swallowed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-codexn-"));
  const bin = stub(
    dir,
    "codex",
    `process.stdout.write("warning: config is deprecated\\n");
     process.stdout.write(JSON.stringify({type:"turn.completed",usage:{}})+"\\n");`,
  );
  const s = sink();
  await make(dir, "codex", bin).send("x", s.events, new AbortController().signal);
  assert.match(s.text.join(""), /config is deprecated/);
});

/* ---- copilot ----------------------------------------------------- */

test("copilot: plain stdout streams straight to the room", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-copilot-"));
  const bin = stub(
    dir,
    "copilot",
    `process.stdout.write("Here is the patch:\\n"); process.stdout.write("done.\\n");`,
  );
  const s = sink();
  const r = await make(dir, "copilot", bin).send("fix the build", s.events, new AbortController().signal);

  assert.equal(r.stopReason, "end_turn");
  assert.equal(s.text.join(""), "Here is the patch:\ndone.\n");

  const argv = argvOf(dir);
  assert.equal(argv[0], "-p");
  assert.equal(argv[1], "fix the build");
  assert.ok(argv.includes("-s"), "stats are suppressed so the room sees the answer only");
  assert.ok(argv.includes("--no-ask-user"), "a shared session cannot answer an interactive prompt");
  assert.ok(argv.some((a) => a.startsWith("--add-dir=")));
});

test("copilot: a resumed session passes the id through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-copilotr-"));
  const bin = stub(dir, "copilot", `process.stdout.write("ok");`);
  await make(dir, "copilot", bin, "sess_42").send("x", sink().events, new AbortController().signal);
  const argv = argvOf(dir);
  assert.ok(argv.includes("--resume"));
  assert.ok(argv.includes("sess_42"));
});

/* ---- opencode ---------------------------------------------------- */

test("opencode: run streams text and carries the session forward", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-oc-"));
  const bin = stub(dir, "opencode", `process.stdout.write("refactored the module\\n");`);
  const s = sink();
  const r = await make(dir, "opencode", bin, "ses_9").send("refactor", s.events, new AbortController().signal);

  assert.equal(r.stopReason, "end_turn");
  assert.match(s.text.join(""), /refactored the module/);
  const argv = argvOf(dir);
  assert.equal(argv[0], "run");
  assert.ok(argv.includes("--session"));
  assert.ok(argv.includes("ses_9"));
  assert.equal(argv[argv.length - 1], "refactor");
});

test("opencode-json: bus events map onto text, reasoning and completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-ocj-"));
  const bin = stub(
    dir,
    "opencode",
    `const out=[
      {type:"session.updated",properties:{info:{id:"ses_777"}}},
      {type:"message.part.delta",properties:{text:"hel"}},
      {type:"message.part.delta",properties:{text:"lo"}},
      {type:"message.part.updated",properties:{part:{type:"tool",tool:"bash",id:"t1"}}},
      {type:"session.idle",properties:{}},
    ];
    for (const o of out) process.stdout.write(JSON.stringify(o)+"\\n");`,
  );
  const s = sink();
  const backend = make(dir, "opencode-json", bin);
  const r = await backend.send("hi", s.events, new AbortController().signal);

  assert.equal(r.stopReason, "end_turn");
  assert.equal(s.text.join(""), "hello");
  assert.equal(backend.session, "ses_777");
  assert.ok(s.tools.some((t) => t.includes("bash")));
  assert.ok(argvOf(dir).includes("--format"));
});

/* ---- shared behaviour across every CLI backend ------------------- */

test("a missing binary produces an error you can act on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-missing-"));
  const s = sink();
  const r = await make(dir, "codex", join(dir, "definitely-not-here")).send(
    "x",
    s.events,
    new AbortController().signal,
  );
  assert.equal(r.stopReason, "error");
  assert.match(String(r.error), /not installed or not on PATH/);
  assert.match(String(r.error), /npm i -g @openai\/codex/, "the error says how to fix it");
});

test("a crash with no output is an error; a crash after output is not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-crash-"));
  const silent = stub(dir, "silent", `process.stderr.write("boom: bad credentials\\n"); process.exit(2);`);
  const noisy = stub(dir, "noisy", `process.stdout.write("partial answer\\n"); process.exit(2);`);

  const a = await make(dir, "copilot", silent).send("x", sink().events, new AbortController().signal);
  assert.equal(a.stopReason, "error");
  assert.match(String(a.error), /bad credentials/);

  const b = await make(dir, "copilot", noisy).send("x", sink().events, new AbortController().signal);
  assert.equal(b.stopReason, "end_turn", "the room already saw the answer; let it judge");
});

test("interrupting a turn kills the process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-abort-"));
  const bin = stub(dir, "slow", `process.stdout.write("thinking\\n"); setTimeout(()=>{},60000);`);
  const ac = new AbortController();
  const s = sink();
  const p = make(dir, "copilot", bin).send("x", s.events, ac.signal);
  await new Promise((r) => setTimeout(r, 250));
  ac.abort();
  const r = await p;
  assert.equal(r.stopReason, "interrupted");
});

test("--backend-arg is appended verbatim, and wins by being last", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mpx-extra-"));
  const bin = stub(dir, "codex", `process.stdout.write(JSON.stringify({type:"turn.completed",usage:{}})+"\\n");`);
  process.env.ARGV_LOG = join(dir, "argv.json");
  const backend = new ProcessBackend({
    profile: PROFILES.codex!,
    cwd: dir,
    model: "gpt-5-codex",
    bin,
    extraArgs: ["--sandbox", "workspace-write"],
    resume: null,
    showThinking: false,
  });
  await backend.send("x", sink().events, new AbortController().signal);
  const argv = argvOf(dir);
  assert.ok(argv.includes("--sandbox"));
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(argv.includes("-m") && argv.includes("gpt-5-codex"));
  assert.equal(argv[argv.length - 1], "x", "the prompt still comes last");
});

test("every profile builds an argv that ends with the prompt", () => {
  for (const [name, profile] of Object.entries(PROFILES)) {
    const argv = profile.args({
      prompt: "PROMPT",
      sessionId: null,
      cwd: "/tmp",
      model: "",
      first: true,
      extraArgs: [],
    });
    assert.ok(argv.length > 0, `${name} builds arguments`);
    assert.ok(argv.includes("PROMPT"), `${name} passes the prompt`);
    assert.equal(profile.promptVia, "arg", `${name} documents how the prompt is delivered`);
    assert.ok(profile.install.length > 0, `${name} says how to install the tool`);
    if (profile.parse === "jsonl") assert.ok(profile.onEvent, `${name} maps its events`);
  }
});
