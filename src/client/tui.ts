import { createInterface, type Interface } from "node:readline";
import { clearLine, cursorTo } from "node:readline";
import type {
  LaneInfo,
  Participant,
  Proposal,
  RoomSnapshot,
  ServerMessage,
  Tally,
} from "../protocol.js";
import { renderTally } from "../core/gate.js";
import { describeGate } from "../core/policy.js";
import * as c from "../util/ansi.js";
import { Connection } from "./connection.js";
import { commandNames, helpLines, parse } from "./commands.js";
import type { Seat, SeatOptions } from "./fullscreen.js";

export type TuiOptions = SeatOptions;

/**
 * The terminal seat.
 *
 * Everything scrolls in a single column above one editable input line. Streamed
 * model output is buffered and flushed line-by-line so it never fights the
 * prompt for the cursor, and every room event is rendered with the same gutter
 * so votes, chat and model output stay visually distinct at a glance.
 */
export class Tui implements Seat {
  private rl: Interface;
  private conn: Connection;
  private opts: TuiOptions;
  private me: Participant | null = null;
  private room: RoomSnapshot | null = null;
  private streamBuf = "";
  private streamTurn: string | null = null;
  private thinkingOpen = false;
  private lastOpenProposal = "";
  /** Characters each lane has produced, for the one-line race heartbeat. */
  private laneChars = new Map<string, number>();
  private lastLaneTick = 0;
  private tty: boolean;
  private width: number;

  constructor(opts: TuiOptions) {
    this.opts = opts;
    this.conn = opts.connection;
    this.tty = Boolean(process.stdout.isTTY);
    this.width = Math.max(48, Math.min(process.stdout.columns ?? 100, 120));

    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.tty,
      prompt: "",
      completer: (line: string) => this.complete(line),
      historySize: 300,
    });

    process.stdout.on("resize", () => {
      this.width = Math.max(48, Math.min(process.stdout.columns ?? 100, 120));
    });

    this.rl.on("line", (line) => this.onLine(line));
    this.rl.on("SIGINT", () => this.onSigint());
    this.rl.on("close", () => this.opts.onExit());

    this.conn.on("message", (msg: ServerMessage) => {
      if (this.opts.onServerMessage?.(msg)) return;
      this.onMessage(msg);
    });
    this.conn.on("warn", (text: string) => this.print(c.yellow(`  ! ${text}`)));
    this.conn.on("closed", (why: string) => {
      this.print(c.red(`  ✕ left the room (${why})`));
      this.opts.onExit();
    });
  }

  start(): void {
    if (this.opts.banner) for (const line of this.opts.banner) this.print(line);
    this.redraw();
  }

  /** Surface something that happened locally, e.g. in this seat's runner. */
  notice(text: string): void {
    this.print(c.dim(`  · ${text}`));
  }

  /* ---------------------------------------------------------------- */
  /* output                                                            */
  /* ---------------------------------------------------------------- */

  /** Print above the input line without disturbing what is being typed. */
  private print(...lines: string[]): void {
    this.flushStream();
    this.writeRaw(lines);
  }

  private writeRaw(lines: string[]): void {
    if (!lines.length) return;
    if (this.tty) {
      cursorTo(process.stdout, 0);
      clearLine(process.stdout, 0);
    }
    process.stdout.write(lines.join("\n") + "\n");
    this.redraw();
  }

  private redraw(): void {
    if (!this.tty) return;
    this.rl.setPrompt(this.prompt());
    this.rl.prompt(true);
  }

  private prompt(): string {
    const room = this.room;
    const bits: string[] = [];
    if (room) {
      bits.push(room.name);
      const gate = describeGate(room.policy.prompt);
      bits.push(gate);
      const open = room.proposals.filter((p) => p.status === "open").length;
      if (open) bits.push(c.yellow(`${open} open`));
      if (room.queued.length) bits.push(c.cyan(`${room.queued.length} queued`));
      if (room.agent.state !== "idle") bits.push(c.magenta(room.agent.state));
      const active = room.runners?.find((r) => r.id === room.activeRunnerId);
      if (active && room.runners.length > 1) bits.push(c.dim(`on ${active.name}`));
    }
    const status = bits.length ? c.dim(`[${bits.join(" · ")}] `) : "";
    const who = this.me ? this.color(this.me)(this.me.name) : this.opts.name;
    return `${status}${who} ${c.bold("❯")} `;
  }

  private color(p: { color: number }): (s: string) => string {
    return c.participantColor(p.color);
  }

  private nameOf(pid: string): string {
    const p = this.room?.participants.find((x) => x.id === pid);
    return p ? this.color(p)(p.name) : c.gray("someone");
  }

  /* ---------------------------------------------------------------- */
  /* streaming model output                                            */
  /* ---------------------------------------------------------------- */

  private appendStream(text: string, kind: "text" | "thinking"): void {
    if (kind === "thinking") {
      if (!this.thinkingOpen) {
        this.writeRaw([c.gray("  ┄ thinking")]);
        this.thinkingOpen = true;
      }
      return; // reasoning is announced, not transcribed, to keep the room readable
    }
    this.streamBuf += text;
    // Flush whole lines, plus any overflow past the wrap width, so long
    // paragraphs appear as they are written instead of all at once.
    for (;;) {
      const nl = this.streamBuf.indexOf("\n");
      if (nl >= 0) {
        const line = this.streamBuf.slice(0, nl);
        this.streamBuf = this.streamBuf.slice(nl + 1);
        this.writeRaw(this.gutter(line));
        continue;
      }
      const limit = this.width - 10;
      if (this.streamBuf.length <= limit) break;
      const cut = this.streamBuf.lastIndexOf(" ", limit);
      const at = cut > limit / 2 ? cut : limit;
      const line = this.streamBuf.slice(0, at);
      this.streamBuf = this.streamBuf.slice(at).replace(/^ /, "");
      this.writeRaw(this.gutter(line));
    }
  }

  private gutter(line: string): string[] {
    return [`${c.magenta("│")} ${line}`];
  }

  private flushStream(): void {
    if (!this.streamBuf.trim()) {
      this.streamBuf = "";
      return;
    }
    const buf = this.streamBuf;
    this.streamBuf = "";
    this.writeRaw(this.gutter(buf));
  }

  /* ---------------------------------------------------------------- */
  /* server events                                                     */
  /* ---------------------------------------------------------------- */

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome": {
        this.me = msg.you;
        this.room = msg.room;
        this.print(
          "",
          c.bold(`  joined ${msg.room.name}`) + c.dim(`  ${msg.motd ?? ""}`),
          c.dim(`  you are ${msg.you.name} (${msg.you.role}) · /help for commands`),
          "",
        );
        this.printRoster();
        return;
      }
      case "snapshot":
        this.room = msg.room;
        this.redraw();
        return;

      case "presence": {
        if (this.room) this.room.participants = msg.participants;
        if (msg.joined) this.print(c.green(`  → ${msg.joined} joined`) + c.dim(`  (${msg.participants.length} in the room)`));
        if (msg.left) this.print(c.gray(`  ← ${msg.left} left`) + c.dim(`  (${msg.participants.length} in the room)`));
        this.redraw();
        return;
      }

      case "proposal":
        this.onProposal(msg.proposal, msg.tally, msg.event);
        return;

      case "resolved":
        this.onResolved(msg.proposal, msg.tally);
        return;

      case "queued":
        if (this.room) this.room.queued = msg.proposalIds;
        this.redraw();
        return;

      case "turnStart": {
        const who = msg.contributors.join(", ");
        this.print("", c.dim(`  ── sending to the model  (${who}) ──`));
        return;
      }

      case "delta":
        // Lane output is not interleaved into the log: three agents writing at
        // once is unreadable as a single stream. The room watches a heartbeat
        // and judges the diffs, which is what it is going to vote on anyway.
        if (msg.lane) return this.laneProgress(msg.lane, msg.kind === "text" ? msg.text.length : 0);
        this.appendStream(msg.text, msg.kind);
        return;

      case "lanes":
        this.onLanes(msg.lanes, msg.laneCount);
        return;

      case "toolResult": {
        if (msg.lane) return;
        this.flushStream();
        const mark = msg.ok ? c.green("✓") : c.red("✗");
        this.print(c.dim(`  ${mark} tool  ${msg.preview.split("\n")[0]}`));
        return;
      }

      case "turnEnd": {
        this.flushStream();
        this.thinkingOpen = false;
        if (msg.stopReason === "lanes") {
          this.laneChars.clear();
          this.printLanes();
          return;
        }
        const bits: string[] = [];
        if (msg.stopReason !== "end_turn") bits.push(msg.stopReason);
        if (msg.usage?.output_tokens) bits.push(`${msg.usage.output_tokens} out`);
        if (msg.error) bits.push(c.red(msg.error));
        this.print(c.dim(`  ── turn complete${bits.length ? "  " + bits.join(" · ") : ""} ──`), "");
        return;
      }

      case "agent":
        if (this.room) this.room.agent = msg.status;
        this.redraw();
        return;

      case "runners": {
        if (!this.room) return;
        const before = this.room.activeRunnerId;
        this.room.runners = msg.runners;
        this.room.activeRunnerId = msg.activeId;
        if (before && msg.activeId && before !== msg.activeId) {
          const now = msg.runners.find((r) => r.id === msg.activeId);
          if (now) this.print(c.yellow(`  ⇄ the session moved to ${now.name}'s ${now.backend}`));
        }
        this.redraw();
        return;
      }

      case "runTurn":
      case "runCancel":
        return;

      case "chat": {
        const p = this.room?.participants.find((x) => x.id === msg.fromId);
        const label = p ? this.color(p)(p.name) : msg.fromName;
        this.print(`  ${c.dim("💬")} ${label}${c.dim(":")} ${msg.text}`);
        return;
      }

      case "policy": {
        if (this.room) this.room.policy = msg.policy;
        this.print(
          c.yellow(`  ⚙ ${msg.byName} set the policy`) +
            c.dim(`  prompts: ${describeGate(msg.policy.prompt)} · tools: ${describeGate(msg.policy.tool)}`),
        );
        return;
      }

      case "notice": {
        const paint = msg.level === "error" ? c.red : msg.level === "warn" ? c.yellow : c.dim;
        this.print(paint(`  · ${msg.text}`));
        return;
      }

      case "error":
        this.print(c.red(`  ✕ ${msg.text}`));
        return;

      case "pong":
        return;
    }
  }

  /* ---------------------------------------------------------------- */
  /* lanes                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * A heartbeat rather than a transcript.
   *
   * While a race runs there is nothing to decide yet, so the room needs one
   * thing only: reassurance that all the lanes are alive and roughly how far
   * along they are. One throttled line does that without drowning the log.
   */
  private laneProgress(lane: string, chars: number): void {
    this.laneChars.set(lane, (this.laneChars.get(lane) ?? 0) + chars);
    const now = Date.now();
    if (now - this.lastLaneTick < LANE_TICK_MS) return;
    this.lastLaneTick = now;
    const bits = [...this.laneChars.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, n]) => `${c.cyan(id)} ${c.dim(kchars(n))}`);
    this.writeRaw([c.dim("  ┄ lanes  ") + bits.join(c.dim("   "))]);
  }

  private onLanes(lanes: LaneInfo[], laneCount: number): void {
    if (!this.room) return;
    const before = new Map(this.room.lanes.map((l) => [l.id, l.state]));
    this.room.lanes = lanes;
    this.room.laneCount = laneCount;
    for (const lane of lanes) {
      if (before.get(lane.id) === lane.state) continue;
      if (lane.state === "running") continue;
      this.print(`  ${laneMark(lane)} ${c.bold(`lane ${lane.id}`)} ${laneSummary(lane)}`);
    }
    this.redraw();
  }

  private printLanes(): void {
    const lanes = this.room?.lanes ?? [];
    if (!lanes.length) {
      const n = this.room?.laneCount ?? 0;
      return this.print(
        c.dim(n ? `  no lanes yet — /race <prompt> opens ${n}` : "  racing is off in this room"),
      );
    }
    this.print(
      "",
      c.dim(`  ${lanes.length} lane${lanes.length === 1 ? "" : "s"}`),
      ...lanes.flatMap((l) => [
        `    ${laneMark(l)} ${c.bold(l.id)}  ${laneSummary(l)}`,
        ...(l.detail ? c.wrapText(l.detail, this.width - 10, "        ").map((x) => c.dim(x)) : []),
        ...(l.branch ? [c.dim(`        ${l.branch}`)] : []),
      ]),
      "",
    );
  }

  private onProposal(p: Proposal, t: Tally, event: "new" | "vote" | "amend"): void {
    this.trackProposal(p);
    const tag = this.color({ color: this.colorFor(p.authorId) });

    if (event === "new") {
      if (p.kind === "lane") {
        const lane = this.room?.lanes.find((l) => l.id === p.lane);
        this.print(
          "",
          `  ${c.green("⚑")} ${c.bold(p.id)} land lane ${c.bold(p.lane ?? "?")}` +
            c.dim(`  ${lane?.summary ?? ""}`),
          ...(lane?.detail ? c.wrapText(lane.detail, this.width - 10, "      ").map((x) => c.dim(x)) : []),
          ...(lane?.dir ? [c.dim(`      look: ${lane.dir}`)] : []),
          this.voteLine(p, t),
        );
        return;
      }
      const kindMark = p.kind === "tool" ? c.yellow("⚙ tool") : c.cyan("▸");
      const head = `  ${kindMark} ${tag(p.authorName)} proposes ${c.bold(p.id)}${p.race ? c.dim(`  (race, ${p.race} lanes)`) : ""}`;
      const body = c.wrapText(p.text, this.width - 8, "      ");
      this.print("", head, ...body.map((l) => (p.kind === "tool" ? c.yellow(l) : l)), this.voteLine(p, t));
      return;
    }

    if (event === "amend") {
      this.print(
        `  ${c.yellow("✎")} ${c.bold(p.id)} amended` + c.dim(" — previous votes cleared"),
        ...c.wrapText(p.text, this.width - 8, "      "),
        this.voteLine(p, t),
      );
      return;
    }

    this.print(this.voteLine(p, t));
  }

  private voteLine(p: Proposal, t: Tally): string {
    const votes = Object.entries(p.votes)
      .map(([pid, v]) => {
        const mark = v.vote === "yes" ? c.green("✓") : v.vote === "no" ? c.red("✗") : c.gray("·");
        return `${mark}${this.nameOf(pid)}`;
      })
      .join(" ");
    const progress = renderTally(t, p.deadline, Date.now());
    const hint =
      t.decision === "pending" && p.status === "open"
        ? c.dim(`   /y ${p.id}  /n ${p.id}${p.kind === "prompt" ? `  /amend ${p.id} …` : ""}`)
        : "";
    return `      ${c.dim("[")}${progress}${c.dim("]")}${votes ? "  " + votes : ""}${hint}`;
  }

  private onResolved(p: Proposal, t: Tally): void {
    this.trackProposal(p);
    const ok = p.status === "approved" || p.status === "sent";
    const mark = ok ? c.green("✓") : c.red("✗");
    const verb =
      p.status === "approved" || p.status === "sent"
        ? p.kind === "tool"
          ? "tool approved"
          : p.kind === "lane"
            ? `landing lane ${p.lane}`
            : p.race
              ? `racing in ${p.race} lanes`
              : "queued for the model"
        : p.status;
    this.print(`  ${mark} ${c.bold(p.id)} ${verb}` + c.dim(`  — ${p.resolution ?? t.reason}`));
  }

  private trackProposal(p: Proposal): void {
    if (!this.room) return;
    const idx = this.room.proposals.findIndex((x) => x.id === p.id);
    if (idx >= 0) this.room.proposals[idx] = p;
    else this.room.proposals.push(p);
    if (p.status === "open") this.lastOpenProposal = p.id;
    this.redraw();
  }

  private colorFor(pid: string): number {
    return this.room?.participants.find((x) => x.id === pid)?.color ?? 0;
  }

  /* ---------------------------------------------------------------- */
  /* input                                                             */
  /* ---------------------------------------------------------------- */

  private onLine(line: string): void {
    const result = parse(line, { defaultProposal: () => this.defaultProposal() });
    switch (result.kind) {
      case "noop":
        this.redraw();
        return;
      case "error":
        this.print(c.red(`  ✕ ${result.text}`));
        return;
      case "send":
        if (!this.conn.connected) this.print(c.dim("  · queued until the room connects"));
        this.conn.send(result.msg);
        this.redraw();
        return;
      case "local":
        this.local(result.action);
        return;
    }
  }

  private defaultProposal(): string {
    const open = this.room?.proposals.filter((p) => p.status === "open") ?? [];
    // Prefer a tool vote: it is blocking the session right now.
    const tool = [...open].reverse().find((p) => p.kind === "tool");
    return (tool ?? open[open.length - 1])?.id ?? this.lastOpenProposal;
  }

  private local(action: string): void {
    switch (action) {
      case "help":
        this.print("", ...helpLines().map((l) => "  " + c.dim(l)), "");
        return;
      case "who":
        this.printRoster();
        return;
      case "queue": {
        const open = this.room?.proposals.filter((p) => p.status === "open") ?? [];
        if (!open.length) return this.print(c.dim("  nothing awaiting a decision"));
        this.print("", ...open.flatMap((p) => [
          `  ${c.bold(p.id)} ${c.dim(p.kind)} ${p.authorName}: ${c.truncate(p.text, this.width - 24)}`,
          this.voteLine(p, this.localTally(p)),
        ]), "");
        return;
      }
      case "status": {
        const r = this.room;
        if (!r) return this.print(c.dim("  not connected yet"));
        this.print(
          "",
          `  room       ${r.name}`,
          `  directory  ${r.cwd}`,
          `  model      ${r.agent.backend}${r.agent.model ? `/${r.agent.model}` : ""}  (${r.agent.state}${r.agent.detail ? ` — ${r.agent.detail}` : ""})`,
          `  prompts    ${describeGate(r.policy.prompt)}`,
          `  tools      ${describeGate(r.policy.tool)}  auto-allow: ${r.policy.autoAllowToolRisks.join(",") || "none"}`,
          `  interrupt  ${r.policy.interrupt}`,
          `  turns      ${r.turnCount}   queued: ${r.queued.length}`,
          `  lanes      ${r.laneCount ? `${describeGate(r.policy.lane)} · /race opens ${r.laneCount}` : "off (not a git repository)"}`,
          `  transcript ${r.transcriptPath ?? "(off)"}`,
        );
        this.printRunners();
        this.print("");
        return;
      }
      case "policy": {
        const r = this.room;
        if (!r) return;
        this.print(
          "",
          `  prompts    ${describeGate(r.policy.prompt)}`,
          `  tools      ${describeGate(r.policy.tool)}`,
          `  auto-allow ${r.policy.autoAllowToolRisks.join(",") || "none"}`,
          `  interrupt  ${r.policy.interrupt}   merge queued: ${r.policy.mergeQueued}`,
          c.dim("  change with /policy <preset> or /policy mode=consensus timeout=30s"),
          "",
        );
        return;
      }
      case "lanes":
        this.printLanes();
        return;
      case "transcript":
        this.print(c.dim(`  transcript: ${this.room?.transcriptPath ?? "(off)"}`));
        return;
      case "clear":
        process.stdout.write("\x1b[2J\x1b[H");
        this.redraw();
        return;
      case "quit":
        this.opts.onExit();
        return;
    }
  }

  /** Approximate a tally locally for display-only listings. */
  private localTally(p: Proposal): Tally {
    const yes = Object.values(p.votes).filter((v) => v.vote === "yes").length;
    const no = Object.values(p.votes).filter((v) => v.vote === "no").length;
    const abstain = Object.values(p.votes).filter((v) => v.vote === "abstain").length;
    const n = (this.room?.participants ?? []).filter((x) => x.connected && x.role !== "observer").length;
    return {
      yes,
      no,
      abstain,
      pending: [],
      electorate: n,
      need: Math.max(0, 1 - yes),
      decision: "pending",
      reason: "",
    };
  }

  private printRoster(): void {
    const ps = this.room?.participants ?? [];
    const mic = this.room?.micHolderId;

    const lines = ps.map((p) => {
      const marks = [
        p.role === "owner" ? c.yellow("host") : p.role === "observer" ? c.gray("observer") : "",
        p.id === mic ? c.cyan("mic") : "",
        p.id === this.me?.id ? c.dim("you") : "",
      ].filter(Boolean);
      return `    ${this.color(p)("●")} ${p.name}${marks.length ? c.dim(`  ${marks.join(" ")}`) : ""}`;
    });
    this.print(c.dim(`  ${ps.length} in the room`), ...lines);
    this.printRunners();
  }

  /**
   * Runners are listed on their own rather than folded into the roster: a seat
   * may offer no account, the host machine may have no seat, and one person can
   * be both. Pairing them by name hides exactly the cases worth seeing.
   */
  private printRunners(): void {
    const runners = this.room?.runners ?? [];
    if (!runners.length) return;
    const activeId = this.room?.activeRunnerId;

    this.print(
      "",
      c.dim(runners.length === 1 ? "  running on 1 account" : `  running on ${runners.length} accounts`),
      ...runners.map((r) => {
        const state = r.exhausted
          ? c.red(`out of capacity${r.exhaustedUntil ? ` until ${new Date(r.exhaustedUntil).toLocaleTimeString()}` : ""}`)
          : r.id === activeId
            ? c.green("running")
            : c.dim("ready");
        const turns = r.turns ? c.dim(`  ${r.turns} turn${r.turns === 1 ? "" : "s"}`) : "";
        return `    ${r.id === activeId ? c.green("▸") : " "} ${r.name.padEnd(16)} ${r.backend.padEnd(14)} ${state}${turns}\n      ${c.dim(r.cwd)}`;
      }),
    );
  }

  private onSigint(): void {
    // First ^C interrupts the model; a second one (with nothing running) exits.
    if (this.room && this.room.agent.state !== "idle") {
      this.conn.send({ t: "interrupt" });
      return;
    }
    this.print(c.dim("  bye"));
    this.opts.onExit();
  }

  private complete(line: string): [string[], string] {
    if (!line.startsWith("/")) return [[], line];
    const hits = commandNames().filter((n) => n.startsWith(line));
    return [hits.length ? hits : commandNames(), line];
  }

  close(): void {
    this.flushStream();
    this.rl.close();
  }
}

/** How often the race heartbeat is allowed to print. */
const LANE_TICK_MS = 4000;

function laneMark(l: LaneInfo): string {
  switch (l.state) {
    case "running":
      return c.cyan("▸");
    case "done":
      return c.green("✓");
    case "landed":
      return c.green("⚑");
    case "empty":
      return c.gray("·");
    case "discarded":
      return c.gray("✗");
    default:
      return c.red("✗");
  }
}

function laneSummary(l: LaneInfo): string {
  switch (l.state) {
    case "running":
      return c.dim("running");
    case "empty":
      return c.dim("finished without changing anything");
    case "failed":
      return c.red(l.error ?? "failed");
    case "landed":
      return c.green(`landed — ${l.summary}`);
    case "discarded":
      return c.dim(`not taken — ${l.summary} · ${l.branch}`);
    default:
      return `${l.summary}${l.error ? c.dim(`  (finished early: ${l.error})`) : ""}`;
  }
}

/** `1.2k` rather than `1234`: the number is a pulse, not a measurement. */
function kchars(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
