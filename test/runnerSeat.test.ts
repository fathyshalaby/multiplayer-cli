import test from "node:test";
import assert from "node:assert/strict";
import { RoomServer } from "../src/server/server.js";
import { LocalWsTransport } from "../src/server/transport.js";
import { Connection } from "../src/client/connection.js";
import { resolvePreset } from "../src/core/policy.js";
import { WebConnection } from "../src/browser/webConnection.js";
import { RunnerSeat, type SiteDriver } from "../src/browser/runnerSeat.js";
import type { ServerMessage } from "../src/protocol.js";
import type { AgentBackend, AgentEvents, TurnResult } from "../src/agent/types.js";

/**
 * Proves the whole browser-runner chain — WebConnection, WebSecureChannel,
 * RunnerSeat — against a real, unmodified RoomServer, the same way
 * `test/failover.test.ts`'s "a real seat runs a real turn on its own CLI"
 * proves LocalRunner against one. The only thing standing in for the real
 * world is the DOM: a scripted `SiteDriver` plays the part of a chat site's
 * page, the same role a stub CLI binary plays for `ProcessBackend` elsewhere
 * in this suite. Everything else — the WebSocket, the handshake, the room's
 * pooling and handoff — is production code.
 */

class HostBackend implements AgentBackend {
  readonly name = "host-cli";
  readonly model = "host-1";
  calls: string[] = [];
  limitAfter = Infinity;
  async send(prompt: string, events: AgentEvents): Promise<TurnResult> {
    this.calls.push(prompt);
    if (this.calls.length > this.limitAfter) {
      return { stopReason: "error", error: "Claude usage limit reached. Your limit will reset at 3pm." };
    }
    events.onText("host answered");
    return { stopReason: "end_turn", usage: { output_tokens: 1 } };
  }
  async close(): Promise<void> {}
}

async function startRoom() {
  const host = new HostBackend();
  const transport = new LocalWsTransport({ host: "127.0.0.1", port: 0, roomName: "rs" });
  const server = new RoomServer({
    transport,
    roomName: "rs",
    token: null,
    policy: resolvePreset("solo")!,
    cwd: process.cwd(),
    backend: "echo",
    model: "",
    maxTokens: 100,
    showThinking: false,
    systemPromptExtra: "",
    backendBin: "",
    backendArgs: [],
    permissionMode: "acceptEdits",
    resume: null,
    attach: null,
    pool: true,
    lanes: 0,
    laneSetup: null,
    transcriptPath: null,
    backendFactory: () => host,
  });
  await server.listen();
  return { server, host, port: transport.port };
}

interface Seat {
  conn: Connection;
  log: ServerMessage[];
}

function connect(port: number, name: string): Promise<Seat> {
  const conn = new Connection({ url: `ws://127.0.0.1:${port}/r/rs`, room: "rs", name, reconnect: false });
  const log: ServerMessage[] = [];
  conn.on("message", (m: ServerMessage) => log.push(m));
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`${name} never joined`)), 5000);
    conn.on("message", (m: ServerMessage) => {
      if (m.t === "welcome") {
        clearTimeout(timer);
        res({ conn, log });
      }
    });
    conn.connect();
  });
}

function until<T>(get: () => T | undefined | false | null, what: string, ms = 5000): Promise<T> {
  const started = Date.now();
  return new Promise((res, rej) => {
    const tick = () => {
      const v = get();
      if (v) return res(v as T);
      if (Date.now() - started > ms) return rej(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** A stand-in for a chat site's page: no real DOM, no real browser. */
class ScriptedSite implements SiteDriver {
  sent: string[] = [];
  cancelled = false;
  private observer: ((text: string, generating: boolean) => void) | null = null;
  private banner: string | null = null;

  constructor(
    private script: { advanceMs: number; text: string; generating: boolean }[],
    private clock: { advance(ms: number): void },
    banner: string | null = null,
  ) {
    this.banner = banner;
  }

  async send(prompt: string): Promise<void> {
    this.sent.push(prompt);
    for (const step of this.script) {
      await Promise.resolve(); // let the room's own message loop run between steps
      this.clock.advance(step.advanceMs);
      this.observer?.(step.text, step.generating);
    }
  }

  watch(onObservation: (text: string, generating: boolean) => void): () => void {
    this.observer = onObservation;
    return () => {
      this.observer = null;
    };
  }

  limitBanner(): string | null {
    return this.banner;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

class FakeClock {
  value = 0;
  advance(ms: number): void {
    this.value += ms;
  }
}

test("a browser runner drives a scripted site and the room hands off to it", async (t) => {
  const { server, host, port } = await startRoom();
  t.after(async () => await server.close());

  const alice = await connect(port, "alice");

  const clock = new FakeClock();
  const site = new ScriptedSite(
    [
      { advanceMs: 50, text: "Hel", generating: true },
      { advanceMs: 50, text: "Hello there", generating: true },
      { advanceMs: 1300, text: "Hello there", generating: false },
    ],
    clock,
  );
  const notices: string[] = [];
  const bobConn = new WebConnection({ url: `ws://127.0.0.1:${port}/r/rs`, room: "rs", name: "bob" });
  const seat = new RunnerSeat(bobConn, "chatgpt-web", site, (n) => notices.push(n), () => clock.value);
  bobConn.on("message", (m) => seat.handle(m));
  bobConn.on("open", () => seat.offer());

  const bobLog: ServerMessage[] = [];
  bobConn.on("message", (m) => bobLog.push(m));
  await bobConn.connect();
  await until(() => bobLog.find((m) => m.t === "welcome"), "bob's browser seat joining");
  t.after(() => bobConn.close());

  await until(
    () => alice.log.find((m) => m.t === "runners" && (m as any).runners.length === 2),
    "bob's browser tab offered to the room",
  );

  // The host is spent, so the turn should move to bob's chat site.
  host.limitAfter = 0;
  alice.conn.send({ t: "propose", text: "who answers this?" });

  await until(() => alice.log.find((m) => m.t === "turnEnd"), "the turn finishing", 15000);
  const text = alice.log.filter((m) => m.t === "delta").map((m) => (m as any).text).join("");
  assert.equal(text, "Hello there");
  assert.equal(host.calls.length, 1, "the host tried once and was spent");
  assert.equal(site.sent.length, 1);
  assert.match(site.sent[0]!, /who answers this/);
  assert.ok(notices.some((n) => /running this turn on your chatgpt-web session/.test(n)));

  const roster = [...alice.log].reverse().find((m) => m.t === "runners") as any;
  assert.equal(roster.activeId, roster.runners.find((r: any) => r.name === "bob").id);

  alice.conn.close();
});

test("a browser runner reports capacity exhaustion the same way a CLI runner does", async (t) => {
  const { server, host, port } = await startRoom();
  t.after(async () => await server.close());

  const alice = await connect(port, "alice");

  const clock = new FakeClock();
  const site = new ScriptedSite(
    [{ advanceMs: 1300, text: "", generating: false }],
    clock,
    "You've reached your usage limit for messages. Try again in 30 minutes.",
  );
  const bobConn = new WebConnection({ url: `ws://127.0.0.1:${port}/r/rs`, room: "rs", name: "bob" });
  const seat = new RunnerSeat(bobConn, "chatgpt-web", site, () => {}, () => clock.value);
  bobConn.on("message", (m) => seat.handle(m));
  bobConn.on("open", () => seat.offer());
  const bobLog: ServerMessage[] = [];
  bobConn.on("message", (m) => bobLog.push(m));
  await bobConn.connect();
  await until(() => bobLog.find((m) => m.t === "welcome"), "bob joining");
  t.after(() => bobConn.close());

  await until(
    () => alice.log.find((m) => m.t === "runners" && (m as any).runners.length === 2),
    "bob offered",
  );

  host.limitAfter = 0;
  alice.conn.send({ t: "propose", text: "go" });

  await until(
    () => alice.log.some((m) => m.t === "runners" && (m as any).runners.every((r: any) => r.exhausted)),
    "both accounts reporting exhausted",
    15000,
  );
  const end = (await until(() => alice.log.find((m) => m.t === "turnEnd"), "the turn ending")) as any;
  assert.match(String(end.error), /out of capacity/);

  alice.conn.close();
});
