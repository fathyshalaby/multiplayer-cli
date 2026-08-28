#!/usr/bin/env node
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { RoomServer } from "./server/server.js";
import { LocalWsTransport, RelayTransport, type Transport } from "./server/transport.js";
import { Relay, MAX_FRAME_BYTES } from "./server/relay.js";
import { Connection } from "./client/connection.js";
import { Tui } from "./client/tui.js";
import { FullScreenSeat, canFullScreen, type Seat, type SeatOptions } from "./client/fullscreen.js";
import { LocalRunner } from "./client/runner.js";
import {
  applyOverrides,
  describeGate,
  presetNames,
  resolvePreset,
  DEFAULT_PRESET,
} from "./core/policy.js";
import { readTranscript } from "./core/transcript.js";
import { DEFAULT_BASE_PORT, DEFAULT_HOST } from "./core/preview.js";
import { BACKENDS, BACKEND_HELP, GATES_TOOLS, type BackendName } from "./agent/index.js";
import { roomName, token as makeToken } from "./util/id.js";
import { bool, multi, num, parseArgs, str, type Parsed } from "./util/args.js";
import { defaultName, readConfig, saveConfig } from "./util/config.js";
import { parseJoinTarget, isLocalHost } from "./util/url.js";
import { detectBackend, installedBackends } from "./util/detect.js";
import * as c from "./util/ansi.js";

/**
 * The version is read from the manifest rather than written down twice.
 *
 * It was written down twice, and `mpx --version` spent two releases claiming
 * to be 0.8.0. A number that has to be updated by hand in two places is a
 * number that will disagree with itself.
 */
function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/src/cli.js -> ../../package.json; src/cli.ts -> ../package.json
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const raw = readFileSync(join(here, rel), "utf8");
      const v = JSON.parse(raw)?.version;
      if (typeof v === "string") return v;
    } catch {
      /* try the next one */
    }
  }
  return "unknown";
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.flags.has("version") || parsed.flags.has("v")) {
    console.log(version());
    return;
  }
  if (parsed.flags.has("help") || parsed.flags.has("h") || !parsed.command) {
    usage(bool(parsed, "all", false));
    return;
  }

  switch (parsed.command) {
    case "share":
      return await cmdHost(parsed, true);
    case "host":
      return await cmdHost(parsed);
    case "serve":
      return await cmdServe(parsed);
    case "join":
      return await cmdJoin(parsed);
    case "relay":
      return await cmdRelay(parsed);
    case "rooms":
      return await cmdRooms(parsed);
    case "transcript":
      return await cmdTranscript(parsed);
    case "policies":
      return cmdPolicies();
    case "backends":
      return cmdBackends();
    case "help":
      return usage(bool(parsed, "all", false));
    default:
      console.error(`unknown command "${parsed.command}"\n`);
      usage();
      process.exitCode = 1;
  }
}

/* ------------------------------------------------------------------ */
/* room configuration                                                  */
/* ------------------------------------------------------------------ */

function buildRoomConfig(p: Parsed, easy = false) {
  const presetName = str(p, "policy", DEFAULT_PRESET);
  const preset = resolvePreset(presetName);
  if (!preset) fatal(`unknown policy "${presetName}" — try one of: ${presetNames().join(", ")}`);

  const overrides = [...p.positional.filter((a) => a.includes("=")), ...multi(p, "set")];
  const { policy, errors } = applyOverrides(preset!, overrides);
  if (errors.length) fatal(errors.join("\n"));

  const asked = str(p, "backend", "");
  const detected = asked ? null : detectBackend();
  const backend = (asked || detected!.backend) as BackendName;
  if (!BACKENDS.includes(backend)) {
    fatal(`unknown backend "${backend}" — try one of: ${BACKENDS.join(", ")}  (see \`mpx backends\`)`);
  }

  const cwd = resolve(str(p, "cwd", process.cwd()));
  const name = str(p, "room", roomName());
  const open = bool(p, "open", false);
  const transcriptPath = bool(p, "transcript", true)
    ? str(p, "transcript-path", join(cwd, ".mpx", `${name}.jsonl`))
    : null;

  // `share` is the no-configuration path, so it reaches for the widest thing
  // that still works: a saved relay if there is one, otherwise the local
  // network. Both are still gated by the room token.
  const savedRelay = readConfig().relay;
  const relay = str(p, "relay", "") || (easy && !bool(p, "local", false) ? savedRelay ?? null : null);
  const defaultBind = easy && !relay && !bool(p, "local", false) ? "0.0.0.0" : "127.0.0.1";

  return {
    detected,
    tls: readTls(p),
    bindHost: str(p, "host", defaultBind),
    port: num(p, "port", 7777),
    relay,
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
      pool: bool(p, "pool", false),
      lanes: num(p, "lanes", 3),
      laneSetup: str(p, "lane-setup", "") || null,
      lanePreview: str(p, "lane-preview", "") || null,
      lanePreviewPort: num(p, "lane-preview-port", DEFAULT_BASE_PORT),
      lanePreviewHost: str(p, "lane-preview-host", DEFAULT_HOST),
      transcriptPath,
    },
  };
}

function makeTransport(cfg: ReturnType<typeof buildRoomConfig>, onWarn: (t: string) => void): Transport {
  if (cfg.relay) {
    return new RelayTransport({ url: cfg.relay, roomName: cfg.server.roomName, onWarn });
  }
  return new LocalWsTransport({
    host: cfg.bindHost,
    port: cfg.port,
    roomName: cfg.server.roomName,
    tls: cfg.tls,
  });
}

/** Read a PEM cert/key pair, if the user supplied one. */
function readTls(p: Parsed): { cert: string; key: string } | null {
  const cert = str(p, "tls-cert", "");
  const key = str(p, "tls-key", "");
  if (!cert && !key) return null;
  if (!cert || !key) fatal("--tls-cert and --tls-key must be given together");
  try {
    return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
  } catch (err) {
    return fatal(`could not read the TLS pair: ${(err as Error).message}`);
  }
}

/**
 * What you see after `mpx share`.
 *
 * It has one job — hand over the link — and every extra line competes with it.
 * So this says who is in the room, what is gated, whether it is encrypted, and
 * then the link.
 *
 * Deliberately absent: racing, splitting, lanes, previews. Someone starting
 * their first room has not asked about any of it, and a banner that recites the
 * feature list teaches nothing while burying the one line that matters. They
 * are in `/help all` and in the docs, for the moment there is a reason to want
 * them.
 */
function inviteBanner(cfg: ReturnType<typeof buildRoomConfig>, server: RoomServer, warnings: string[]): string[] {
  const s = cfg.server;
  const gatesTools = GATES_TOOLS.includes(s.backend);
  const share = server.shareUrl();
  const out: string[] = [
    "",
    c.bold(`  ${c.cyan(s.roomName)}`) + c.dim(`   ${s.backend}${s.model ? `/${s.model}` : ""}  ·  ${s.cwd}`),
    ...(cfg.detected ? [c.dim(`  ${cfg.detected.why}`)] : []),
    c.dim(
      `  prompts: ${describeGate(s.policy.prompt)}   tools: ${
        gatesTools
          ? `${describeGate(s.policy.tool)} (auto-allow: ${s.policy.autoAllowToolRisks.join(",") || "none"})`
          : `${s.backend}'s own permissions`
      }`,
    ),
    ...(s.attach ? [c.dim(`  attached to ${s.attach}`)] : []),
    s.token
      ? c.dim("  end-to-end encrypted — the token in the link is the key, and never leaves this machine")
      : c.yellow("  --open: no token, so nothing is encrypted. Keep this to a network you trust."),
    ...(s.pool
      ? [c.yellow("  --pool: seats that join with --runner can take turns on their own account (experimental)")]
      : []),
    "",
  ];

  if (share) {
    out.push(c.bold("  Send this to your team:"));
    out.push("");
    out.push(`    ${c.green(c.underline(share))}`);
    out.push("");
    out.push(c.dim("    Opening it gives them a seat in the browser, or the command to join from a terminal."));
  } else {
    out.push(c.bold("  invite your team:"));
    out.push(`    ${c.green(`mpx join ${server.joinUrl()}`)}`);
  }
  for (const d of server.inviteDetail()) out.push(c.dim(`    ${d}`));
  for (const w of warnings) out.push(c.yellow(`    ! ${w}`));
  out.push("");
  return out;
}

/**
 * Pick a seat for this terminal.
 *
 * The full-screen one is the default because a room has outgrown a single
 * scrolling column — a race alone puts several agents on screen at once. The
 * plain one is not a lesser fallback: it is what you want in a pipe, in CI, in
 * a 40-column pane, and in any terminal that will not do alternate screens.
 */
function makeSeat(p: Parsed, opts: SeatOptions): Seat {
  const plain = bool(p, "plain", false);
  return !plain && canFullScreen() ? new FullScreenSeat(opts) : new Tui(opts);
}

/* ------------------------------------------------------------------ */
/* host / serve                                                        */
/* ------------------------------------------------------------------ */

async function cmdHost(p: Parsed, easy = false): Promise<void> {
  const cfg = buildRoomConfig(p, easy);
  if (cfg.relay && str(p, "relay", "")) saveConfig({ relay: cfg.relay });

  const warnings: string[] = [];
  const transport = makeTransport(cfg, (t) => warnings.push(t));
  const server = new RoomServer({ ...cfg.server, transport });
  await server.listen();

  const name = str(p, "name", defaultName());
  saveConfig({ name });
  const conn = new Connection({
    url: server.selfUrl(),
    room: cfg.server.roomName,
    token: cfg.server.token,
    name,
    reconnect: true,
  });
  const tui = makeSeat(p, {
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
  const share = server.shareUrl();
  if (share) console.log(`share:      ${share}`);
  console.log(`terminal:   mpx join ${server.joinUrl()}`);
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
  /**
   * The link can come from the environment instead of the command line.
   *
   * A link on the command line is in `ps` for every account on the machine,
   * and in the shell history afterwards. The token in it is the room's key, so
   * that is a worse place for it than the wire it is deliberately kept off.
   * Most of the time nobody else is on the machine and it does not matter; on a
   * shared box, a build agent or a jump host it does, and there was no way to
   * avoid it.
   *
   * The argument still wins when both are given, so nothing that works today
   * stops working.
   */
  const fromEnv = process.env.MPX_LINK?.trim() || null;
  const target =
    p.positional[0] ??
    (typeof p.flags.get("url") === "string" ? String(p.flags.get("url")) : null) ??
    fromEnv;
  if (!target) {
    fatal("usage: mpx join <link>   (the host prints one when the room starts)\n       or set MPX_LINK, to keep the token out of your shell history");
  }

  const join = parseJoinTarget(target!);
  guardPlaintext(join.url, join.token, bool(p, "insecure", false));

  const name = str(p, "name", defaultName());
  const observer = bool(p, "observer", false);
  const conn = new Connection({
    url: join.url,
    room: join.room,
    token: join.token,
    name,
    reconnect: true,
    ...(observer ? { observer: true } : {}),
  });

  // Experimental, and off unless asked for: offer this machine's own logged-in
  // CLI so turns can run on your subscription instead of the host's.
  const wantRunner = bool(p, "runner", false) && !observer;
  const detected = str(p, "backend", "") || (wantRunner ? detectBackend().backend : "");
  const canRun = wantRunner && detected && detected !== "echo" && BACKENDS.includes(detected as BackendName);

  let runner: LocalRunner | null = null;

  const tui: Seat = makeSeat(p, {
    connection: conn,
    name,
    ...(canRun ? { onServerMessage: (msg) => runner!.handle(msg) } : {}),
    banner: [
      "",
      c.dim(`  connecting to ${join.url} …`),
      conn.encrypted
        ? c.dim("  end-to-end encrypted with the room token")
        : c.yellow("  this room has no token, so traffic is not encrypted"),
      ...(canRun
        ? [c.dim(`  offering your ${detected} session, if the host has pooling on`)]
        : wantRunner
          ? [c.yellow("  --runner: no coding CLI found here, so turns stay on the host's account")]
          : []),
    ],
    onExit: () => {
      void runner?.close();
      tui.close();
      conn.close();
      process.exit(0);
    },
  });

  if (canRun) {
    runner = new LocalRunner({
      connection: conn,
      backend: detected as BackendName,
      cwd: resolve(str(p, "cwd", process.cwd())),
      model: str(p, "model", ""),
      maxTokens: num(p, "max-tokens", 32000),
      showThinking: bool(p, "thinking", false),
      backendBin: str(p, "backend-bin", ""),
      backendArgs: multi(p, "backend-arg"),
      permissionMode: str(p, "permission-mode", "acceptEdits"),
      resume: str(p, "resume", "") || null,
      attach: str(p, "attach", "") || null,
      onNotice: (text) => tui.notice(text),
    });
    conn.on("open", () => runner!.offer());
  }

  conn.connect();
  tui.start();
  saveConfig({ name });
}

/**
 * Refuse to carry a session across the open internet in the clear.
 *
 * An encrypted room is safe on plain ws:// — the payload is sealed with the
 * token and a relay only moves ciphertext. An *open* room has no token and
 * therefore no key, so plaintext to a public address would put the whole
 * session on the wire for anyone on the path.
 */
function guardPlaintext(url: string, token: string | null, allow: boolean): void {
  if (token || isLocalHost(url) || allow) return;
  fatal(
    `refusing to join ${url} in the clear.\n` +
      `  This room has no token, so nothing can be encrypted, and the address is not local —\n` +
      `  the whole session would cross the internet readable by anyone on the path.\n` +
      `  Ask the host to drop --open, use wss://, or pass --insecure if you accept the risk.`,
  );
}

/* ------------------------------------------------------------------ */
/* relay                                                               */
/* ------------------------------------------------------------------ */

async function cmdRelay(p: Parsed): Promise<void> {
  const bind = str(p, "host", "0.0.0.0");
  const tls = readTls(p);
  const relay = new Relay({
    host: bind,
    port: num(p, "port", 7788),
    tls,
    maxRooms: num(p, "max-rooms", 64),
    maxPeersPerRoom: num(p, "max-peers", 32),
    joinsPerMinute: num(p, "joins-per-minute", 60),
    maxFrameBytes: num(p, "max-frame", MAX_FRAME_BYTES),
    directory: bool(p, "directory", false),
    ...(bool(p, "quiet", false)
      ? {}
      : { onLog: (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`) }),
  });
  const port = await relay.listen();

  const scheme = relay.isSecure ? "wss" : "ws";
  console.log(`multiplayer-cli relay listening on ${bind}:${port}${relay.isSecure ? " (TLS)" : ""}`);
  console.log("");
  console.log(`  hosts run:  mpx share --relay ${scheme}://<this-machine>:${port}`);
  console.log("  then hand out the link it prints. No inbound port on their side.");
  console.log("");
  console.log(c.dim("  Room traffic is sealed end-to-end with each room's token before it reaches"));
  console.log(c.dim("  this relay, so what passes through is ciphertext with a channel number."));
  console.log(c.dim("  A relay operator sees who is connected and how much they say — not what."));
  if (!relay.isSecure) {
    console.log("");
    console.log(c.yellow("  No TLS here. Room contents are still encrypted, but the connection"));
    console.log(c.yellow("  metadata is not. Add --tls-cert/--tls-key, or put a terminator in front."));
  }

  const stop = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

/* ------------------------------------------------------------------ */
/* rooms                                                               */
/* ------------------------------------------------------------------ */

/**
 * List the rooms a relay is hosting.
 *
 * Only names, seat counts and ages — never a token. Seeing a room here does not
 * get you into it; you still need the link someone sent you. It answers "is
 * anything running?" without becoming a way in.
 */
async function cmdRooms(p: Parsed): Promise<void> {
  const target = p.positional[0] ?? readConfig().relay ?? "";
  if (!target) {
    fatal("usage: mpx rooms <relay-url>   (or set one once with `mpx share --relay <url>`)");
  }

  const base = normalizeRelay(target!);
  let body: { rooms?: { name: string; seats: number; upSeconds: number }[]; error?: string };
  try {
    const res = await fetch(`${base}/rooms`, { signal: AbortSignal.timeout(10_000) });
    body = (await res.json()) as typeof body;
    if (res.status === 404) {
      fatal(`${base} does not publish a directory. The relay operator can enable it with \`mpx relay --directory\`.`);
    }
    if (!res.ok) fatal(`${base} answered ${res.status}`);
  } catch (err) {
    return fatal(`could not reach ${base}: ${(err as Error).message}`);
  }

  const rooms = body.rooms ?? [];
  if (!rooms.length) {
    console.log(c.dim(`  no rooms hosted on ${base} right now`));
    return;
  }
  console.log("");
  for (const r of rooms.sort((a, b) => a.name.localeCompare(b.name))) {
    const seats = `${r.seats} seat${r.seats === 1 ? "" : "s"}`;
    console.log(`  ${c.bold(r.name.padEnd(24))} ${seats.padEnd(9)} ${c.dim(`up ${humanAge(r.upSeconds)}`)}`);
  }
  console.log("");
  console.log(c.dim("  Names only — you still need the invite link to join one."));
  console.log("");
}

/** http(s) for the directory, whatever scheme the relay was given as. */
function normalizeRelay(url: string): string {
  const u = url.trim().replace(/\/+$/, "");
  if (u.startsWith("wss://")) return "https://" + u.slice(6);
  if (u.startsWith("ws://")) return "http://" + u.slice(5);
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return "https://" + u;
}

function humanAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
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
      `  ${c.bold(name.padEnd(13))} prompts: ${describeGate(p.prompt).padEnd(22)} tools: ${describeGate(p.tool).padEnd(20)} landing: ${describeGate(p.lane).padEnd(11)} direction: ${describeGate(p.choice)}`,
    );
  }
  console.log("");
  console.log(c.dim("  landing picks which lane of a /race gets merged; direction ratifies a fork the"));
  console.log(c.dim("  agent stopped at. Neither has a timer in any preset: silence is consent for a"));
  console.log(c.dim("  question, not for a merge and not for a direction."));
  console.log("");
  console.log(c.dim("  override any of it:  mpx host --policy team --set mode=quorum --set quorum=3 --set timeout=90s"));
  console.log(c.dim("  keys: mode, quorum, veto, timeout, minYes, proposerAutoYes, soloBypass,"));
  console.log(c.dim("        tool.*, lane.*, choice.*, autoAllow, interrupt, merge, attribute"));
  console.log("");
}

function cmdBackends(): void {
  const have = installedBackends();
  const pick = detectBackend();
  console.log("");
  console.log(c.dim(`  ${c.bold("mpx share")} would use ${c.cyan(pick.backend)} — ${pick.why}`));
  console.log("");
  for (const name of BACKENDS) {
    const gates = GATES_TOOLS.includes(name) ? c.green("room votes on tools") : c.dim("own permissions");
    const mark = have.has(name) ? c.green("●") : c.dim("○");
    console.log(`  ${mark} ${c.bold(name.padEnd(15))} ${gates}`);
    console.log(`    ${" ".repeat(15)}${c.dim(BACKEND_HELP[name])}`);
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

function fatal(msg: string): never {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/**
 * Two tiers on purpose. Almost everyone needs three lines; burying those under
 * forty flags they will never touch is how a good CLI stops feeling like one.
 */
function usage(all = false): void {
  console.log(`
${c.bold("multiplayer-cli")} — make your AI session multiplayer

  ${c.green("mpx share")}                    start a session, get a link to send your team
  mpx join <link>              take a seat in someone's session

  Paste the link in chat. They click it, or run the command it shows.
  Type to propose. ${c.green("/y")} to agree. Nothing is sent until the room agrees.

  ${c.dim("mpx rooms")}                    what is running on your relay
  ${c.dim("mpx help --all")}               every option
  ${c.dim("mpx backends")}                 which AI CLIs you can use
  ${c.dim("mpx policies")}                 how the room can decide things
`);
  if (!all) return;

  console.log(`${c.bold("More commands")}
  mpx relay [--port n]         run a relay, so hosts need no open port
                               --tls-cert/--tls-key to serve wss:// directly
                               --directory to publish the names it hosts
                               --max-rooms/--max-peers/--joins-per-minute/--max-frame
                               bound what one caller can take from it
  mpx rooms [relay-url]        what is running on a relay (names only)
  mpx serve [options]          run a room with no seat of your own
  mpx transcript <file>        replay a session's audit log

${c.bold("Room options")}  (share / serve)
  --backend <name>       ${BACKENDS.join(" | ")}
                         (default: whichever you already have installed)
  --policy <name>        ${presetNames().join(" | ")}   (default: ${DEFAULT_PRESET})
  --set key=value        override one policy key; repeatable
  --model <id>           model to ask the backend for
  --cwd <dir>            working directory the session and its tools see
  --room <name>          fixed room name instead of a generated one
  --thinking             stream summarized reasoning to the room
  --no-transcript        do not write an audit log

${c.bold("Who can reach it")}
  mpx share              on your network, gated by the token in the link
  --local                this machine only
  --relay <url>          through a relay, reachable anywhere (remembered after once)
  --open                 no token, and therefore no encryption
  --tls-cert <f> --tls-key <f>   serve wss:// and https:// directly
  --port <n>  --host <addr>      pick them yourself

${c.bold("Security")}
  Room traffic is end-to-end encrypted with the token in the share link, so a
  relay, a proxy or a TLS terminator moves ciphertext it cannot read. The token
  is never sent over the network — a seat proves it has one by producing a frame
  the room can decrypt.
  --insecure             join an unencrypted room on a public address anyway

${c.bold("Seat options")}
  --name <name>          your display name (remembered)
  MPX_LINK=<link>        take the link from the environment instead of argv, so
                         the token stays out of ps and your shell history
  --observer             read-only: see everything, propose nothing
  --plain                one scrolling column instead of the full-screen panes
                         (also MPX_PLAIN=1; automatic when piped or on a small
                         terminal)

${c.bold("Pointing at an existing session")}
  --resume <id>          continue a session/thread the backend already has
  --attach <url>         attach to a running \`opencode serve\`
  --backend-bin <path>   override the binary the backend launches
  --backend-arg <arg>    append a verbatim argument to it; repeatable

${c.bold("Lanes")}
  In a git repository the room can work in several worktrees at once, then vote
  on what comes back. Two shapes, and the difference is what the lanes are to
  each other:
  /race [n] <prompt>     the same prompt n ways — the room lands one of them
  /split <a> | <b>       different work at once — the room lands each on its own
  --lanes <n>            lanes a bare /race opens; 0 turns lanes off (default: 3)
  --lane-setup <cmd>     run this in each fresh checkout first, e.g. "npm ci"
  --lane-preview <cmd>   start each finished lane so the room can look at it,
                         e.g. "npm run dev -- --port {port}" ({port} and $PORT
                         are the lane's own)
  --lane-preview-port <n>  where preview port hunting starts (default: 4173)
  --lane-preview-host <h>  hostname shown in preview URLs (default: 127.0.0.1)

${c.bold("Crossroads")}
  The other direction: the agent stops at a fork and asks the room which way,
  before spending the work. Any backend can raise one.
  /ask <q> | <a> | <b>   put a fork to the room yourself
  /fork                  what the room is deciding right now

${c.bold("Sharing the cost")}  ${c.yellow("experimental")}
  By default every turn runs on the host's account. These let the room
  carry on when that account runs out of capacity:
  --pool                 (host) allow seats to take turns on their own account
  --runner               (seat) offer your machine and subscription to the room

${c.bold("In the session")}
  Panes: the reply on the left, the roster, open votes and lanes beside it.
  Tab completes · ↑↓ history · PgUp/PgDn scrollback · Ctrl-C interrupts.
  type anything          propose it to the room
  /y   /n <reason>       approve, or veto with a reason that gets recorded
  /amend  /say  /stop    rewrite a proposal · talk to the room only · interrupt
  /race [n] <prompt>     try it n ways at once, then vote on the diffs
  /ask <q> | <a> | <b>   ask the room to pick a direction
  /help                  everything else

${c.dim("No AI CLI installed? `mpx share` still runs, on an offline demo backend.")}
`);
}

main().catch((err) => {
  console.error(c.red(`error: ${(err as Error)?.message ?? err}`));
  process.exit(1);
});
