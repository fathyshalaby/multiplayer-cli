#!/usr/bin/env node
import { networkInterfaces, homedir } from "node:os";
import { resolve, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RoomServer } from "./server/server.js";
import { Connection } from "./client/connection.js";
import { Tui } from "./client/tui.js";
import { applyOverrides, describeGate, presetNames, resolvePreset, DEFAULT_PRESET } from "./core/policy.js";
import { readTranscript } from "./core/transcript.js";
import { BACKENDS, type BackendName } from "./agent/index.js";
import { roomName, token as makeToken } from "./util/id.js";
import { bool, num, parseArgs, str, type Parsed } from "./util/args.js";
import * as c from "./util/ansi.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);

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
    case "transcript":
      return await cmdTranscript(parsed);
    case "policies":
      return cmdPolicies();
    case "help":
      return usage();
    default:
      console.error(`unknown command "${parsed.command}"\n`);
      usage();
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* host / serve                                                        */
/* ------------------------------------------------------------------ */

function buildServerOptions(p: Parsed) {
  const presetName = str(p, "policy", DEFAULT_PRESET);
  const preset = resolvePreset(presetName);
  if (!preset) {
    fatal(`unknown policy "${presetName}" — try one of: ${presetNames().join(", ")}`);
  }
  const overrides = [...p.positional.filter((a) => a.includes("="))];
  for (const [k, v] of p.flags) {
    if (k === "set" && typeof v === "string") overrides.push(v);
  }
  const { policy, errors } = applyOverrides(preset!, overrides);
  if (errors.length) fatal(errors.join("\n"));

  const backend = str(p, "backend", "anthropic") as BackendName;
  if (!BACKENDS.includes(backend)) {
    fatal(`unknown backend "${backend}" — try one of: ${BACKENDS.join(", ")}`);
  }

  const cwd = resolve(str(p, "cwd", process.cwd()));
  const name = str(p, "room", roomName());
  const open = bool(p, "open", false);
  const transcript =
    bool(p, "transcript", true) === false
      ? null
      : str(p, "transcript-path", join(cwd, ".mpx", `${name}.jsonl`));

  return {
    host: str(p, "host", "127.0.0.1"),
    port: num(p, "port", 7777),
    roomName: name,
    token: open ? null : str(p, "token", makeToken()),
    policy,
    cwd,
    backend,
    model: str(p, "model", backend === "anthropic" ? "claude-opus-5" : ""),
    maxTokens: num(p, "max-tokens", 32000),
    showThinking: bool(p, "thinking", false),
    systemPromptExtra: str(p, "system", ""),
    claudeBin: str(p, "claude-bin", "claude"),
    permissionMode: str(p, "permission-mode", "acceptEdits"),
    resume: str(p, "resume", "") || null,
    transcriptPath: transcript,
  };
}

async function cmdHost(p: Parsed): Promise<void> {
  const opts = buildServerOptions(p);
  const server = new RoomServer(opts);
  const { port } = await server.listen();

  const url = joinUrl(opts.host, port, opts.token);
  const lan = lanUrl(port, opts.token);

  const banner = [
    "",
    c.bold(`  multiplayer-cli  ·  room ${c.cyan(opts.roomName)}`),
    c.dim(`  ${opts.backend}${opts.model ? `/${opts.model}` : ""}  ·  ${opts.cwd}`),
    c.dim(`  prompts: ${describeGate(opts.policy.prompt)}   tools: ${describeGate(opts.policy.tool)}   auto-allow: ${opts.policy.autoAllowToolRisks.join(",") || "none"}`),
    "",
    c.bold("  invite your team:"),
    `    ${c.green(`mpx join ${url}`)}`,
    ...(lan && lan !== url ? [c.dim(`    on your network:  mpx join ${lan}`)] : []),
    ...(opts.host === "127.0.0.1"
      ? [c.dim("    remote teammate:  ssh -R 7777:localhost:" + port + " them@host   (then join 127.0.0.1)")]
      : []),
    "",
  ];

  const conn = new Connection({
    url: joinUrl("127.0.0.1", port, opts.token),
    name: str(p, "name", defaultName()),
    reconnect: true,
  });

  const tui = new Tui({
    connection: conn,
    name: str(p, "name", defaultName()),
    banner,
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
  const opts = buildServerOptions(p);
  const server = new RoomServer(opts);
  const { port } = await server.listen();
  const url = joinUrl(opts.host === "0.0.0.0" ? lanAddress() ?? "127.0.0.1" : opts.host, port, opts.token);
  console.log(`room ${opts.roomName} listening on ${opts.host}:${port}`);
  console.log(`join with:  mpx join ${url}`);
  if (opts.transcriptPath) console.log(`transcript: ${opts.transcriptPath}`);
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

  const url = normalizeUrl(target!);
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
/* transcript                                                          */
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
          if (!votesOnly) break;
          console.log(`${ts} ${c.dim("vote")} ${msg.proposal.id} ${msg.tally.yes}✓ ${msg.tally.no}✗`);
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
    console.log(`  ${c.bold(name.padEnd(13))} prompts: ${describeGate(p.prompt).padEnd(22)} tools: ${describeGate(p.tool).padEnd(22)} auto-allow: ${p.autoAllowToolRisks.join(",") || "none"}`);
  }
  console.log("");
  console.log(c.dim("  override any of it:  mpx host --policy team --set mode=quorum --set quorum=3 --set timeout=90s"));
  console.log(c.dim("  keys: mode, quorum, veto, timeout, minYes, proposerAutoYes, soloBypass,"));
  console.log(c.dim("        tool.mode, tool.timeout, …, autoAllow, interrupt, merge, attribute"));
  console.log("");
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function joinUrl(host: string, port: number, token: string | null): string {
  const h = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `ws://${h}:${port}/${token ? `?t=${token}` : ""}`;
}

function lanUrl(port: number, token: string | null): string | null {
  const addr = lanAddress();
  return addr ? joinUrl(addr, port, token) : null;
}

function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

function normalizeUrl(target: string): string {
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
  ${c.bold("mpx transcript")} <file>      replay a session's audit log
  ${c.bold("mpx policies")}               list the decision presets

${c.bold("Room options")}  (host / serve)
  --policy <name>        decision preset: ${presetNames().join(" | ")}   (default: ${DEFAULT_PRESET})
  --set key=value        override one policy key; repeatable
  --backend <name>       ${BACKENDS.join(" | ")}   (default: anthropic)
  --model <id>           model for the anthropic backend (default: claude-opus-5)
  --cwd <dir>            working directory the session and its tools see
  --port <n>             listen port (default: 7777)
  --host <addr>          bind address (default: 127.0.0.1; use 0.0.0.0 for your LAN)
  --open                 no join token — anyone who can reach the port can join
  --room <name>          fixed room name instead of a generated one
  --thinking             stream summarized reasoning to the room
  --no-transcript        do not write an audit log
  --resume <id>          resume a claude-code session (claude-code backend)
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
