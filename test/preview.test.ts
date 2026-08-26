import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import {
  DEFAULT_HOST,
  Previews,
  freePort,
  probe,
  renderCommand,
} from "../src/core/preview.js";

const never = new AbortController().signal;

async function scratch(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mpx-preview-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A server started the way a real one is: a shell command that spawns node,
 * rather than node directly.
 *
 * This shape is the whole point. `npm run dev` is a shell that spawns a server,
 * so killing only the process we spawned leaves the server running and holding
 * the port. A test that spawns node directly would pass against a broken kill.
 */
async function serverScript(dir: string): Promise<string> {
  const file = join(dir, "server.mjs");
  await writeFile(
    file,
    [
      `import { createServer } from "node:net";`,
      `const port = Number(process.env.PORT ?? process.argv[2]);`,
      // Ignore the polite signal, so only a group SIGKILL gets rid of this.
      `process.on("SIGTERM", () => {});`,
      `createServer((s) => s.end()).listen(port, "127.0.0.1");`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  return file;
}

function hold(port: number): Promise<Server> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(port, DEFAULT_HOST, () => done(s));
  });
}

/* ------------------------------------------------------------------ */
/* the pure parts                                                      */
/* ------------------------------------------------------------------ */

test("renderCommand puts the lane's port where the command asks for it", () => {
  assert.equal(renderCommand("dev --port {port}", 4173), "dev --port 4173");
  assert.equal(renderCommand("a {port} b {port}", 9), "a 9 b 9");
  assert.equal(renderCommand("no placeholder", 4173), "no placeholder");
  // A command that reads $PORT instead is left alone; the env carries it.
  assert.equal(renderCommand("dev --port $PORT", 4173), "dev --port $PORT");
});

test("probe tells an occupied port from an empty one", async (t) => {
  const port = await freePort(45_000, new Set());
  assert.ok(port !== null);
  assert.equal(await probe(port!), false, "nothing is listening yet");

  const server = await hold(port!);
  t.after(() => new Promise((r) => server.close(() => r(null))));
  assert.equal(await probe(port!), true, "now something is");
});

test("freePort skips what is already spoken for", async (t) => {
  const first = await freePort(46_000, new Set());
  assert.ok(first !== null);

  // Claimed by a sibling lane that has not bound yet: the whole reason the
  // taken set exists, since bindable() would happily hand this out twice.
  const second = await freePort(46_000, new Set([first!]));
  assert.notEqual(second, first);

  // And a port genuinely held by someone else is skipped too.
  const server = await hold(second!);
  t.after(() => new Promise((r) => server.close(() => r(null))));
  const third = await freePort(46_000, new Set([first!]));
  assert.notEqual(third, second, "a bound port is not offered");
});

/* ------------------------------------------------------------------ */
/* starting and stopping for real                                      */
/* ------------------------------------------------------------------ */

test("a preview comes up and is reachable at the url it reports", async (t) => {
  const dir = await scratch(t);
  const script = await serverScript(dir);
  const previews = new Previews({
    command: `node ${JSON.stringify(script)}`,
    basePort: 47_000,
    host: DEFAULT_HOST,
    readyMs: 15_000,
  });
  t.after(() => previews.stopAll());

  const started = await previews.start("A", dir, never);
  assert.ok(started.ok, `expected a preview, got ${started.ok ? "" : started.error}`);
  assert.match(started.value.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(await probe(started.value.port), true, "the reported port answers");
});

test("two lanes never land on the same port", async (t) => {
  const dir = await scratch(t);
  const script = await serverScript(dir);
  const previews = new Previews({
    command: `node ${JSON.stringify(script)}`,
    basePort: 48_000,
    host: DEFAULT_HOST,
    readyMs: 15_000,
  });
  t.after(() => previews.stopAll());

  const [a, b] = await Promise.all([previews.start("A", dir, never), previews.start("B", dir, never)]);
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.value.port, b.value.port);
  assert.equal(previews.count, 2);
});

/**
 * The regression that matters.
 *
 * The server here is spawned by a shell *and* ignores SIGTERM, so it survives
 * both of the half-measures: killing the direct child, and asking politely.
 * Only signalling the process group and then escalating gets the port back.
 */
test("stopping a preview frees its port, even when the server was spawned by a shell and ignores SIGTERM", async (t) => {
  const dir = await scratch(t);
  const script = await serverScript(dir);
  const previews = new Previews({
    command: `sh -c 'exec node ${JSON.stringify(script)}'`,
    basePort: 49_000,
    host: DEFAULT_HOST,
    readyMs: 15_000,
  });
  t.after(() => previews.stopAll());

  const started = await previews.start("A", dir, never);
  assert.ok(started.ok, `expected a preview, got ${started.ok ? "" : started.error}`);
  const port = started.value.port;
  assert.equal(await probe(port), true);

  await previews.stop("A");
  assert.equal(previews.count, 0);
  assert.equal(await probe(port), false, "the port is free again");

  // And it can be handed straight back out, which is what the next race needs.
  assert.equal(await freePort(port, new Set()), port);
});

test("stopping twice is not an error", async (t) => {
  const dir = await scratch(t);
  const script = await serverScript(dir);
  const previews = new Previews({
    command: `node ${JSON.stringify(script)}`,
    basePort: 50_000,
    host: DEFAULT_HOST,
    readyMs: 15_000,
  });
  const started = await previews.start("A", dir, never);
  assert.ok(started.ok);
  await previews.stop("A");
  await previews.stop("A");
  assert.equal(previews.count, 0);
});

test("a preview command that exits is reported without waiting out the clock", async (t) => {
  const dir = await scratch(t);
  const previews = new Previews({
    command: "echo nope >&2; exit 1",
    basePort: 51_000,
    host: DEFAULT_HOST,
    // Long on purpose: a correct implementation notices the exit and returns
    // immediately rather than sitting here.
    readyMs: 30_000,
  });
  t.after(() => previews.stopAll());

  const began = Date.now();
  const started = await previews.start("A", dir, never);
  assert.equal(started.ok, false);
  assert.ok(!started.ok && /exited without listening/.test(started.error), started.ok ? "" : started.error);
  assert.ok(!started.ok && /nope/.test(started.error), "the command's own output is quoted back");
  assert.ok(Date.now() - began < 10_000, "it did not wait for the timeout");
});

test("a failed start leaves nothing running and gives the port back", async (t) => {
  const dir = await scratch(t);
  const previews = new Previews({
    command: "exit 1",
    basePort: 52_000,
    host: DEFAULT_HOST,
    readyMs: 5_000,
  });
  const started = await previews.start("A", dir, never);
  assert.equal(started.ok, false);
  assert.equal(previews.count, 0, "nothing is left in the table");
  // The next lane gets the same port rather than being pushed along by a
  // reservation nobody is using.
  assert.equal(await freePort(52_000, new Set()), 52_000);
});

test("one lane cannot have two previews", async (t) => {
  const dir = await scratch(t);
  const script = await serverScript(dir);
  const previews = new Previews({
    command: `node ${JSON.stringify(script)}`,
    basePort: 53_000,
    host: DEFAULT_HOST,
    readyMs: 15_000,
  });
  t.after(() => previews.stopAll());

  const first = await previews.start("A", dir, never);
  assert.ok(first.ok);
  const second = await previews.start("A", dir, never);
  assert.equal(second.ok, false);
  assert.equal(previews.count, 1);
});

test("stopAll leaves no ports held", async (t) => {
  const dir = await scratch(t);
  const script = await serverScript(dir);
  const previews = new Previews({
    command: `sh -c 'exec node ${JSON.stringify(script)}'`,
    basePort: 54_000,
    host: DEFAULT_HOST,
    readyMs: 15_000,
  });
  const [a, b] = await Promise.all([previews.start("A", dir, never), previews.start("B", dir, never)]);
  assert.ok(a.ok && b.ok);

  await previews.stopAll();
  assert.equal(previews.count, 0);
  assert.equal(await probe(a.value.port), false);
  assert.equal(await probe(b.value.port), false);
});

test("an aborted start does not leave a server behind", async (t) => {
  const dir = await scratch(t);
  const script = await serverScript(dir);
  const previews = new Previews({
    command: `sh -c 'sleep 0.4; exec node ${JSON.stringify(script)}'`,
    basePort: 55_000,
    host: DEFAULT_HOST,
    readyMs: 15_000,
  });
  t.after(() => previews.stopAll());

  const stop = new AbortController();
  const pending = previews.start("A", dir, stop.signal);
  stop.abort();
  const started = await pending;
  assert.equal(started.ok, false);
  assert.equal(previews.count, 0);
});
