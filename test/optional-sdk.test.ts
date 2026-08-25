import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AnthropicBackend, MissingSdkError } from "../src/agent/anthropic.js";
import { createBackend } from "../src/agent/index.js";
import type { AgentEvents } from "../src/agent/types.js";

/**
 * The Anthropic SDK is 12MB and serves one backend — the only one needing an
 * API key rather than a subscription. It is optional, and these pin that: it
 * must not be reachable from an import, only from actually using that backend.
 */

const opts = {
  cwd: ".",
  model: "claude-opus-5",
  maxTokens: 100,
  showThinking: false,
  systemPrompt: "",
};

function sink(): AgentEvents {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async () => ({ allow: true, reason: "" }),
    onToolResult: () => {},
    onNotice: () => {},
  };
}

test("nothing in the agent layer imports the SDK statically", () => {
  // A value import here would pull 12MB into every install and every bundle,
  // however lazily the class behaves afterwards.
  const src = readFileSync("src/agent/anthropic.ts", "utf8");
  assert.match(src, /import type Anthropic from "@anthropic-ai\/sdk"/, "types only");
  assert.ok(
    !/^import Anthropic from "@anthropic-ai\/sdk"/m.test(src),
    "no value import of the SDK",
  );
  assert.match(src, /import\("@anthropic-ai\/sdk"\)/, "loaded on demand instead");

  const tools = readFileSync("src/agent/tools.ts", "utf8");
  assert.match(tools, /import type Anthropic/, "tool definitions need only the types");
});

test("it is an optional peer, not something every install downloads", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies), ["ws"], "one runtime dependency");
  assert.ok(pkg.peerDependencies["@anthropic-ai/sdk"], "declared as a peer");
  assert.equal(pkg.peerDependenciesMeta["@anthropic-ai/sdk"].optional, true);
});

test("the editor extension does not bundle it", () => {
  const build = readFileSync("scripts/build-extension.mjs", "utf8");
  assert.match(build, /external:\s*\["vscode",\s*"@anthropic-ai\/sdk"\]/);

  const manifest = JSON.parse(readFileSync("extension/package.json", "utf8"));
  const backends = manifest.contributes.configuration.properties["multiplayer.backend"].enum;
  assert.ok(!backends.includes("anthropic"), "and does not offer a backend it cannot load");
  assert.ok(backends.includes("claude-code") && backends.includes("codex"));
});

test("constructing the backend never touches the SDK", () => {
  let loaded = false;
  const backend = new AnthropicBackend({ ...opts }, undefined, async () => {
    loaded = true;
    throw new Error("should not get here");
  });
  assert.equal(backend.name, "anthropic");
  assert.equal(loaded, false, "not until a turn actually runs");

  // The factory is the path everything else uses, and it is just as lazy.
  const viaFactory = createBackend({
    ...opts,
    backend: "anthropic",
    backendBin: "",
    backendArgs: [],
    permissionMode: "acceptEdits",
    resume: null,
    attach: null,
  });
  assert.equal(viaFactory.name, "anthropic");
});

test("a missing SDK produces an error that says what to do about it", async () => {
  const backend = new AnthropicBackend({ ...opts }, undefined, async () => {
    throw new Error("Cannot find package '@anthropic-ai/sdk'");
  });
  const result = await backend.send("hello", sink(), new AbortController().signal);

  assert.equal(result.stopReason, "error");
  const message = String(result.error);
  assert.match(message, /not installed/);
  assert.match(message, /npm install -g @anthropic-ai\/sdk/, "the fix");
  assert.match(message, /--backend claude-code/, "and the alternative");
  assert.match(message, /Cannot find package/, "with the underlying cause kept");
});

test("MissingSdkError explains why it is optional at all", () => {
  const err = new MissingSdkError("nope");
  assert.equal(err.name, "MissingSdkError");
  assert.match(err.message, /optional on purpose/);
  assert.match(err.message, /already signed into/);
});

test("a turn still runs when the SDK is present", async () => {
  // Only the loader is stubbed; the backend's own logic is untouched.
  const fakeClient = {
    messages: {
      stream: () => ({
        on: () => {},
        finalMessage: async () => ({
          content: [{ type: "text", text: "hi" }],
          usage: { input_tokens: 1, output_tokens: 2 },
          stop_reason: "end_turn",
        }),
      }),
    },
  };
  const backend = new AnthropicBackend({ ...opts }, fakeClient as never);
  const seen: string[] = [];
  const result = await backend.send(
    "hello",
    { ...sink(), onText: (t) => seen.push(t) },
    new AbortController().signal,
  );
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.usage?.output_tokens, 2);
  void seen;
});
