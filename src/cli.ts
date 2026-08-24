#!/usr/bin/env node
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RoomServer } from "./server/server.js";
import { LocalWsTransport, RelayTransport, type Transport } from "./server/transport.js";
import { Relay } from "./server/relay.js";
import { Connection } from "./client/connection.js";
import { Tui } from "./client/tui.js";
import {
  applyOverrides,
  describeGate,
  presetNames,
  resolvePreset,
  DEFAULT_PRESET,
} from "./core/policy.js";
import { readTranscript } from "./core/transcript.js";
import { BACKENDS, BACKEND_HELP, GATES_TOOLS, type BackendName } from "./agent/index.js";
import { roomName, token as makeToken } from "./util/id.js";
import { bool, multi, num, parseArgs, str, type Parsed } from "./util/args.js";
import * as c from "./util/ansi.js";

const VERSION = "0.2.0";

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.flags.has("version") || parsed.flags.has("v")) {
    console.log(VERSION);
    return;
  }
  if (parsed.flags.has("help") || parsed.flags.has("h") || !parsed.command) {
    usage();
    return;
  }

  switch (parsed.command) {
    case "host":
      return await cmdHost(parsed);
    case "serve":
      return await cmdServe(parsed);
    case "join":
      return await cmdJoin(parsed);
    case "relay":
      return await cmdRelay(parsed);
    case "transcript":
      return await cmdTranscript(parsed);
    case "policies":
      return cmdPolicies();
    case "backends":
      return cmdBackends();
    case "help":
      return usage();
    default:
      console.error(`unknown command "${parsed.command}"\n`);
      usage();
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* room configuration                                                  */
/* ------------------------------------------------------------------ */

function buildRoomConfig(p: Parsed) {
  const presetName = str(p, "policy", DEFAULT_PRESET);
  const preset = resolvePreset(presetName);
  if (!preset) fatal(`unknown policy "${presetName}" — try one of: ${presetNames().join(", ")}`);

  const overrides = [...p.positional.filter((a) => a.includes("=")), ...multi(p, "set")];
  const { policy, errors } = applyOverrides(preset!, overrides);
  if (errors.length) fatal(errors.join("\n"));

  const backend = str(p, "backend", "anthropic") as BackendName;
  if (!BACKENDS.includes(backend)) {
    fatal(`unknown backend "${backend}" — try one of: ${BACKENDS.join(", ")}  (see \`mpx backends\`)`);
  }

  const cwd = resolve(str(p, "cwd", process.cwd()));
  const name = str(p, "room", roomName());
  const open = bool(p, "open", false);
  const transcriptPath = bool(p, "transcript", true)
    ? str(p, "transcript-path", join(cwd, ".mpx", `${name}.jsonl`))
    : null;

  return {
    bindHost: str(p, "host", "127.0.0.1"),
    port: num(p, "port", 7777),
    relay: str(p, "relay", "") || null,
    server: {
      roomName: name,
      token: open ? null : str(p, "token", makeToken()),
      policy,
      cwd,
      backend,
      model: str(p, "model", backend === "anthropic" ? "claude-opus-5" : ""),
      maxTokens: num(p, "max-tokens", 32000),
      showThinking: bool(p, "thinking", false),
      systemPromptExtra: str(p, "system", ""),
      backendBin: str(p, "backend-bin", "") || str(p, "claude-bin", ""),
      backendArgs: multi(p, "backend-arg"),
      permissionMode: str(p, "permission-mode", "acceptEdits"),
      resume: str(p, "resume", "") || null,
      attach: str(p, "attach", "") || null,
      transcriptPath,
    },
  };
}

function makeTransport(cfg: ReturnType<typeof buildRoomConfig>, onWarn: (t: string) => void): Transport {
  if (cfg.relay) {
    return new RelayTransport({ url: cfg.relay, roomName: cfg.server.roomName, onWarn });
  }
  return new LocalWsTransport({ host: cfg.bindHost, port: cfg.port, roomName: cfg.server.roomName });
}

function inviteBanner(cfg: ReturnType<typeof buildRoomConfig>, server: RoomServer, warnings: string[]): string[] {
  const s = cfg.server;
  const gatesTools = GATES_TOOLS.includes(s.backend);
  return [
    "",
    c.bold(`  multiplayer-cli  ·  room ${c.cyan(s.roomName)}`),
    c.dim(`  ${s.backend}${s.model ? `/${s.model}` : ""}  ·  ${s.cwd}`),
    c.dim(
      `  prompts: ${describeGate(s.policy.prompt)}   tools: ${
        gatesTools
          ? `${describeGate(s.policy.tool)} (auto-allow: ${s.policy.autoAllowToolRisks.join(",") || "none"})`
          : `${s.backend}'s own permissions`
      }`,
    ),
    ...(s.attach ? [c.dim(`  attached to ${s.attach}`)] : []),
    "",
    c.bold("  invite your team:"),
    `    ${c.green(`mpx join ${server.joinUrl()}`)}`,
    ...server.inviteDetail().map((d) => c.dim(`    ${d}`)),
    ...warnings.map((w) => c.yellow(`    ! ${w}`)),
    "",
  ];
}

/* ------------------------------------------------------------------ */
/* host / serve                                                        */
/* ------------------------------------------------------------------ */

async function cmdHost(p: Parsed): Promise<void> {
  const cfg = buildRoomConfig(p);
  const warnings: string[] = [];
  const transport = makeTransport(cfg, (t) => warnings.push(t));
  const server = new RoomServer({ ...cfg.server, transport });
  await server.listen();

  const name = str(p, "name", defaultName());
  const conn = new Connection({ url: server.joinUrl(), name, reconnect: true });
  const tui = new Tui({
    connection: conn,
    name,
    banner: inviteBanner(cfg, server, warnings),
    onExit: () => void shutdown(),
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    tui.close();
    conn.close();
    await server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());

  conn.connect();
  tui.start();
}

async function cmdServe(p: Parsed): Promise<void> {
  const cfg = buildRoomConfig(p);
  const transport = makeTransport(cfg, (t) => console.error(`! ${t}`));
  const server = new RoomServer({ ...cfg.server, transport });
  await server.listen();

  console.log(`room ${cfg.server.roomName} · ${cfg.server.backend}${cfg.server.model ? `/${cfg.server.model}` : ""}`);
  console.log(`join with:  mpx join ${server.joinUrl()}`);
  for (const line of server.inviteDetail()) console.log(`            ${line}`);
  if (cfg.server.transcriptPath) console.log(`transcript: ${cfg.server.transcriptPath}`);

  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

/* ------------------------------------------------------------------ */
/* join                                                                */
/* ------------------------------------------------------------------ */

async function cmdJoin(p: Parsed): Promise<void> {
  const target = p.positional[0] ?? (typeof p.flags.get("url") === "string" ? String(p.flags.get("url")) : null);
  if (!target) fatal("usage: mpx join <url>   (the host prints one when the room starts)");

  const url = normalizeJoinUrl(target!);
  const name = str(p, "name", defaultName());
  const conn = new Connection({
    url,
    name,
    reconnect: true,
    ...(bool(p, "observer", false) ? { observer: true } : {}),
  });

  const tui = new Tui({
    connection: conn,
    name,
    banner: ["", c.dim(`  connecting to ${url.replace(/\?t=.*/, "?t=…")} …`)],
    onExit: () => {
      tui.close();
      conn.close();
      process.exit(0);
    },
  });

  conn.connect();
  tui.start();
  rememberName(name);
}

/* ------------------------------------------------------------------ */
/* relay                                                               */
/* ------------------------------------------------------------------ */

async function cmdRelay(p: Parsed): Promise<void> {
  const bind = str(p, "host", "0.0.0.0");
  const relay = new Relay({
    host: bind,
    port: num(p, "port", 7788),
    maxRooms: num(p, "max-rooms", 64),
    maxPeersPerRoom: num(p, "max-peers", 32),
    joinsPerMinute: num(p, "joins-per-minute", 60),
    ...(bool(p, "quiet", false)
      ? {}
      : { onLog: (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`) }),
  });
  const port = await relay.listen();

  console.log(`multiplayer-cli relay listening on ${bind}:${port}`);
  console.log("");
  console.log(`  hosts run:  mpx host --relay ws://<this-machine>:${port}`);
  console.log("  then hand out the join URL it prints. No inbound port on their side.");
  console.log("");
  console.log(c.dim("  The relay forwards frames between a room's host and its seats. It never"));
  console.log(c.dim("  receives the room token and cannot admit anyone the host would refuse —"));
  console.log(c.dim("  but session content passes through in the clear. Run your own, behind TLS."));

  const stop = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

/* ------------------------------------------------------------------ */
/* transcript / listings                                               */
/* ------------------------------------------------------------------ */

async function cmdTranscript(p: Parsed): Promise<void> {
  const path = p.positional[0];
  if (!path) fatal("usage: mpx transcript <file.jsonl>");
  const entries = await readTranscript(path!);
  const votesOnly = bool(p, "votes", false);

  for (const { at, msg } of entries) {
    const ts = c.gray(new Date(at).toISOString().slice(11, 19));
    switch (msg.t) {
      case "proposal":
        if (msg.event !== "new") {
          if (votesOnly) console.log(`${ts} ${c.dim("vote")} ${msg.proposal.id} ${msg.tally.yes}✓ ${msg.tally.no}✗`);
          break;
        }
        console.log(`${ts} ${c.cyan("▸")} ${msg.proposal.authorName} ${c.bold(msg.proposal.id)}: ${msg.proposal.text}`);
        break;
      case "resolved": {
        const ok = msg.proposal.status === "approved" || msg.proposal.status === "sent";
        console.log(`${ts} ${ok ? c.green("✓") : c.red("✗")} ${msg.proposal.id} ${msg.proposal.status} — ${msg.proposal.resolution ?? ""}`);
        break;
      }
      case "turnStart":
        if (!votesOnly) console.log(`${ts} ${c.dim(`── turn (${msg.contributors.join(", ")}) ──`)}`);
        break;
      case "delta":
        if (!votesOnly && msg.kind === "text") {
          for (const line of msg.text.split("\n")) console.log(`${ts} ${c.magenta("│")} ${line}`);
        }
        break;
      case "toolResult":
        if (!votesOnly) console.log(`${ts} ${msg.ok ? c.green("✓") : c.red("✗")} tool ${msg.preview.split("\n")[0]}`);
        break;
      case "chat":
        if (!votesOnly) console.log(`${ts} ${c.dim("💬")} ${msg.fromName}: ${msg.text}`);
        break;
      case "policy":
        console.log(`${ts} ${c.yellow("⚙")} ${msg.byName} set prompts=${describeGate(msg.policy.prompt)} tools=${describeGate(msg.policy.tool)}`);
        break;
      case "turnEnd":
        if (!votesOnly && msg.error) console.log(`${ts} ${c.red("✕")} ${msg.error}`);
        break;
      default:
        break;
    }
  }
}

function cmdPolicies(): void {
  console.log("");
  for (const name of presetNames()) {
    const p = resolvePreset(name)!;
    console.log(
      `  ${c.bold(name.padEnd(13))} prompts: ${describeGate(p.prompt).padEnd(22)} tools: ${describeGate(p.tool).padEnd(22)} auto-allow: ${p.autoAllowToolRisks.join(",") || "none"}`,
    );
  }
  console.log("");
  console.log(c.dim("  override any of it:  mpx host --policy team --set mode=quorum --set quorum=3 --set timeout=90s"));
  console.log(c.dim("  keys: mode, quorum, veto, timeout, minYes, proposerAutoYes, soloBypass,"));
  console.log(c.dim("        tool.mode, tool.timeout, …, autoAllow, interrupt, merge, attribute"));
  console.log("");
}

function cmdBackends(): void {
  console.log("");
  for (const name of BACKENDS) {
    const gates = GATES_TOOLS.includes(name) ? c.green("room votes on tools") : c.dim("own permissions");
    console.log(`  ${c.bold(name.padEnd(15))} ${gates}`);
    console.log(`  ${" ".repeat(15)} ${c.dim(BACKEND_HELP[name])}`);
  }
  console.log("");
  console.log(c.dim("  Every backend gates what the room SENDS. Only anthropic and echo also put the"));
  console.log(c.dim("  model's own tool calls to a vote; the rest enforce their own permission systems."));
  console.log("");
  console.log(c.dim("  When a CLI's flags drift, repair it without waiting for a release here:"));
  console.log(c.dim("    mpx host --backend codex --backend-bin /path/to/codex \\"));
  console.log(c.dim("             --backend-arg --sandbox --backend-arg workspace-write"));
  console.log("");
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizeJoinUrl(target: string): string {
  if (target.startsWith("ws://") || target.startsWith("wss://")) return target;
  if (target.startsWith("http://")) return "ws://" + target.slice(7);
  if (target.startsWith("https://")) return "wss://" + target.slice(8);
  return "ws://" + target;
}

function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "multiplayer-cli", "config.json");
}

function defaultName(): string {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    if (typeof raw?.name === "string" && raw.name) return raw.name;
  } catch {
    /* no saved name yet */
  }
  return process.env.USER || process.env.USERNAME || "anon";
}

function rememberName(name: string): void {
  try {
    const path = configPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({ name }, null, 2));
  } catch {
    /* a read-only home is not worth failing a session over */
  }
}

function fatal(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

function usage(): void {
  console.log(`
${c.bold("multiplayer-cli")} — make your AI session multiplayer

  ${c.bold("mpx host")}  [options]        start a room, share the AI session, and take a seat
  ${c.bold("mpx join")}  <url> [options]  join someone else's room
  ${c.bold("mpx serve")} [options]        run a room with no local seat (server only)
  ${c.bold("mpx relay")} [options]        run a relay so hosts need no inbound port
  ${c.bold("mpx transcript")} <file>      replay a session's audit log
  ${c.bold("mpx backends")}               list the AI CLIs you can put in a room
  ${c.bold("mpx policies")}               list the decision presets

${c.bold("Room options")}  (host / serve)
  --backend <name>       ${BACKENDS.join(" | ")}
  --policy <name>        decision preset: ${presetNames().join(" | ")}   (default: ${DEFAULT_PRESET})
  --set key=value        override one policy key; repeatable
  --model <id>           model to ask the backend for
  --cwd <dir>            working directory the session and its tools see
  --room <name>          fixed room name instead of a generated one
  --thinking             stream summarized reasoning to the room
  --no-transcript        do not write an audit log

${c.bold("Reaching your team")}
  --port <n>             listen port (default: 7777)
  --host <addr>          bind address (default: 127.0.0.1; 0.0.0.0 for your LAN)
  --relay <url>          serve through a relay instead — no inbound port needed
  --open                 no join token; anyone who can reach the room may join

${c.bold("Riding an existing session")}
  --resume <id>          continue a session/thread the backend already has
  --attach <url>         attach to a running \`opencode serve\` other clients are on
  --backend-bin <path>   override the binary the backend launches
  --backend-arg <arg>    append a verbatim argument to it; repeatable
  --permission-mode <m>  claude-code permission mode (default: acceptEdits)

${c.bold("Seat options")}  (host / join)
  --name <name>          your display name (remembered between sessions)
  --observer             join read-only: you see everything, you cannot propose or vote

${c.bold("In the session")}
  type anything          propose it to the room
  /y  /n  /amend         approve, veto, or rewrite what is pending
  /say                   talk to the room without spending a turn
  /stop                  interrupt the model    /help  for everything else

${c.dim("Try it with no API key:  mpx host --backend echo --policy pair")}
`);
}

main().catch((err) => {
  console.error(c.red(`error: ${(err as Error)?.message ?? err}`));
  process.exit(1);
});
