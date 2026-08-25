import { emitKeypressEvents } from "node:readline";
import type { ServerMessage } from "../protocol.js";
import { describeGate } from "../core/policy.js";
import * as c from "../util/ansi.js";
import type { Connection } from "./connection.js";
import { commandNames, helpLines, parse } from "./commands.js";
import { applyKey, newEditor, type EditorState, type Key } from "./editor.js";
import { fits, render, type Size } from "./layout.js";
import { RoomView } from "./roomView.js";
import { Screen } from "./screen.js";

export interface SeatOptions {
  connection: Connection;
  name: string;
  /** Intercepts the runner protocol before the UI sees it. */
  onServerMessage?: (msg: ServerMessage) => boolean;
  /** Shown once, in the transcript, e.g. the join command for teammates. */
  banner?: string[];
  onExit: () => void;
}

/** What `mpx` drives, whichever seat it picked. */
export interface Seat {
  start(): void;
  notice(text: string): void;
  close(): void;
}

/** How long a hint under the input stays before the status line comes back. */
const HINT_MS = 4000;
/** Redraw at most this often; a burst of deltas becomes one frame. */
const FRAME_MS = 24;

/**
 * The full-screen seat: panes instead of a scrolling log.
 *
 * The room does not fit in a single column any more. A race puts several
 * agents' worth of state on screen at once, and what a person needs to see —
 * who is here, what is waiting on their vote, which lane is winning — is
 * standing information, not something that should scroll away under the
 * model's next paragraph.
 *
 * All of the thinking lives elsewhere: `roomView` accumulates the state,
 * `layout` turns it into lines, `editor` interprets keys, `screen` puts the
 * lines on the terminal. This file is the wiring, and is the only part that
 * needs a real terminal to run.
 */
export class FullScreenSeat implements Seat {
  private opts: SeatOptions;
  private conn: Connection;
  private view = new RoomView();
  private screen: Screen;
  private input: EditorState = newEditor();
  private scroll = 0;
  private hint: string | null = null;
  private hintTimer: NodeJS.Timeout | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private closed = false;
  private onKeypress: (str: string | undefined, key: Key) => void;
  private onResize: () => void;

  constructor(opts: SeatOptions) {
    this.opts = opts;
    this.conn = opts.connection;
    this.screen = new Screen(process.stdout);

    this.onKeypress = (str, key) => this.key(str, key);
    this.onResize = () => {
      this.screen.invalidate();
      this.paint();
    };

    this.conn.on("message", (msg: ServerMessage) => {
      if (this.opts.onServerMessage?.(msg)) return;
      this.view.apply(msg);
      // Reading back through the log should not be interrupted by new output,
      // so anything arriving while scrolled up keeps its distance from the
      // bottom rather than yanking the view down.
      if (this.scroll > 0) this.scroll += 1;
      this.paint();
    });
    this.conn.on("warn", (text: string) => this.say(c.yellow(`! ${text}`)));
    this.conn.on("open", () => {
      this.view.setConnected(true, this.conn.encrypted);
      this.paint();
    });
    this.conn.on("closed", (why: string) => {
      this.view.setConnected(false, this.conn.encrypted);
      this.say(c.red(`left the room (${why})`));
      this.paint();
      this.opts.onExit();
    });
  }

  start(): void {
    this.view.setConnected(false, this.conn.encrypted);
    for (const line of this.opts.banner ?? []) this.view.raw(line);

    this.screen.enter();
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", this.onKeypress);
    process.stdout.on("resize", this.onResize);

    // Deadlines count down without anything arriving from the room, so the
    // frame has to be rebuilt on a clock as well as on events.
    this.tick = setInterval(() => this.paint(), 1000);
    this.tick.unref?.();
    this.paint();
  }

  notice(text: string): void {
    this.say(c.dim(text));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    if (this.hintTimer) clearTimeout(this.hintTimer);
    if (this.tick) clearInterval(this.tick);
    process.stdin.off("keypress", this.onKeypress);
    process.stdout.off("resize", this.onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.screen.leave();
  }

  /* ---------------------------------------------------------------- */
  /* input                                                             */
  /* ---------------------------------------------------------------- */

  private key(str: string | undefined, key: Key): void {
    const { state, action } = applyKey(this.input, str, key, {
      complete: (line) => (line.startsWith("/") ? commandNames().filter((n) => n.startsWith(line)) : []),
      page: Math.max(3, this.size().rows - 8),
    });
    this.input = state;

    switch (action.kind) {
      case "submit":
        this.submit(action.text);
        break;
      case "interrupt":
        // First Ctrl-C stops the model; a second, with nothing running, leaves.
        if (this.view.snapshot().agent !== "idle") {
          this.conn.send({ t: "interrupt" });
          this.setHint("interrupting…");
        } else {
          this.opts.onExit();
          return;
        }
        break;
      case "quit":
        this.opts.onExit();
        return;
      case "scroll":
        this.scroll = Math.max(0, this.scroll + action.delta);
        break;
      case "redraw":
        this.screen.invalidate();
        break;
      case "suggest":
        this.setHint(action.options.join("  "));
        break;
      default:
        break;
    }
    this.paint();
  }

  private submit(line: string): void {
    if (!line.trim()) return;
    // Sending puts you back at the bottom: you just said something, so the
    // answer is what you want to be looking at.
    this.scroll = 0;
    const result = parse(line, { defaultProposal: () => this.view.defaultProposalId() ?? "" });
    switch (result.kind) {
      case "send":
        if (!this.conn.connected) this.say(c.dim("queued until the room connects"));
        this.conn.send(result.msg);
        return;
      case "error":
        this.say(c.red(`✕ ${result.text}`));
        return;
      case "local":
        this.local(result.action);
        return;
      default:
        return;
    }
  }

  private local(action: string): void {
    const v = this.view.snapshot();
    switch (action) {
      case "help":
        for (const l of helpLines()) this.say(c.dim(l));
        return;
      case "who":
        this.say(c.dim(`${v.participants.length} in the room`));
        for (const p of v.participants) {
          const marks = [
            p.role === "owner" ? "host" : p.role === "observer" ? "observer" : "",
            p.id === v.youId ? "you" : "",
          ].filter(Boolean);
          this.say(`  ${c.participantColor(p.color)("●")} ${p.name}${marks.length ? c.dim(`  ${marks.join(" ")}`) : ""}`);
        }
        for (const r of v.runners) {
          this.say(c.dim(`  ${r.id === v.activeRunnerId ? "▸" : "·"} ${r.name} ${r.backend}${r.exhausted ? " (out of capacity)" : ""}`));
        }
        return;
      case "queue": {
        const open = v.proposals.filter((p) => p.open);
        if (!open.length) return this.say(c.dim("nothing awaiting a decision"));
        for (const card of open) {
          this.say(`${c.bold(card.proposal.id)} ${c.dim(card.proposal.kind)} ${card.proposal.authorName}: ${card.proposal.text}`);
          this.say(c.dim(`   ${card.progress}`));
        }
        return;
      }
      case "status":
        this.say(c.dim(`room       ${v.room}`));
        this.say(c.dim(`directory  ${v.cwd}`));
        this.say(c.dim(`model      ${v.backend}${v.model ? `/${v.model}` : ""} (${v.agent}${v.agentDetail ? ` — ${v.agentDetail}` : ""})`));
        this.say(c.dim(`prompts    ${describeGate(v.policy.prompt)}`));
        this.say(c.dim(`tools      ${describeGate(v.policy.tool)}  auto-allow: ${v.policy.autoAllowToolRisks.join(",") || "none"}`));
        this.say(c.dim(`lanes      ${v.laneCount ? `${describeGate(v.policy.lane)} · /race opens ${v.laneCount}` : "off (not a git repository)"}`));
        this.say(c.dim(`turns      ${v.turnCount}   queued: ${v.queued.length}`));
        this.say(c.dim(`transcript ${v.transcriptPath ?? "(off)"}`));
        return;
      case "policy":
        this.say(c.dim(`prompts    ${describeGate(v.policy.prompt)}`));
        this.say(c.dim(`tools      ${describeGate(v.policy.tool)}`));
        this.say(c.dim(`lanes      ${describeGate(v.policy.lane)}`));
        this.say(c.dim(`interrupt  ${v.policy.interrupt}   merge queued: ${v.policy.mergeQueued}`));
        this.say(c.dim("change with /policy <preset> or /policy mode=consensus timeout=30s"));
        return;
      case "lanes": {
        if (!v.lanes.length) {
          return this.say(c.dim(v.laneCount ? `no lanes yet — /race <prompt> opens ${v.laneCount}` : "racing is off in this room"));
        }
        for (const l of v.lanes) {
          this.say(`  ${c.bold(l.id)}  ${l.state}${l.summary ? ` · ${l.summary}` : ""}${l.error ? ` · ${l.error}` : ""}`);
          if (l.branch) this.say(c.dim(`     ${l.branch}`));
        }
        return;
      }
      case "transcript":
        this.say(c.dim(`transcript: ${v.transcriptPath ?? "(off)"}`));
        return;
      case "clear":
        this.view.clearLog();
        this.screen.invalidate();
        return;
      case "quit":
        this.opts.onExit();
        return;
      default:
        return;
    }
  }

  /* ---------------------------------------------------------------- */
  /* output                                                            */
  /* ---------------------------------------------------------------- */

  /** Put a locally-produced line in the transcript, as the room's own notices are. */
  private say(text: string): void {
    this.view.apply({ t: "notice", level: "info", text });
    this.paint();
  }

  private setHint(text: string): void {
    this.hint = text;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.hint = null;
      this.paint();
    }, HINT_MS);
    this.hintTimer.unref?.();
  }

  private size(): Size {
    return { cols: process.stdout.columns ?? 100, rows: process.stdout.rows ?? 30 };
  }

  /** Coalesce a burst of events into one frame. */
  private paint(): void {
    if (this.closed || this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.drawNow();
    }, FRAME_MS);
    this.frameTimer.unref?.();
  }

  private drawNow(): void {
    if (this.closed) return;
    const size = this.size();
    if (!fits(size)) return;
    this.screen.draw(
      render(size, {
        view: this.view.snapshot(),
        input: { text: this.input.text, cursor: this.input.cursor },
        scroll: this.scroll,
        ...(this.hint ? { hint: this.hint } : {}),
        now: Date.now(),
      }),
    );
  }
}

/** Whether this terminal can host the full-screen seat. */
export function canFullScreen(): boolean {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false;
  if (process.env.TERM === "dumb") return false;
  if (process.env.MPX_PLAIN) return false;
  return fits({ cols: process.stdout.columns ?? 0, rows: process.stdout.rows ?? 0 });
}
