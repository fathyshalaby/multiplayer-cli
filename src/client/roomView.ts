import type {
  LaneInfo,
  Participant,
  Proposal,
  RoomPolicy,
  RoomSnapshot,
  RunnerInfo,
  ServerMessage,
  Tally,
} from "../protocol.js";
import { PRESETS, describeGate } from "../core/policy.js";
import { renderTally } from "../core/gate.js";

/**
 * Everything a graphical seat needs to draw, derived from the room's own
 * messages.
 *
 * This sits beside the terminal UI rather than inside the editor extension,
 * because none of it is editor-specific: accumulating a streamed reply, keeping
 * proposals in a sensible order, knowing which one a bare "approve" means. It
 * is also where the bugs would be, and it should not need an editor to test.
 */

export type EntryKind = "model" | "chat" | "notice" | "turn" | "tool" | "raw";

export interface LogEntry {
  kind: EntryKind;
  text: string;
  /** Display name for chat, empty otherwise. */
  who: string;
  /** Palette index, so a person is the same colour everywhere. */
  color: number;
  at: number;
  /** Set on `model` entries so streamed deltas append to the right one. */
  turnId?: string;
}

export interface ProposalCard {
  proposal: Proposal;
  tally: Tally | null;
  /** Progress line, e.g. `2/3 ✓ · 1 pending · 18s left`. */
  progress: string;
  open: boolean;
}

export interface ViewState {
  connected: boolean;
  encrypted: boolean;
  room: string;
  backend: string;
  gate: string;
  agent: string;
  cwd: string;
  youId: string;
  youName: string;
  shareUrl: string;
  participants: Participant[];
  proposals: ProposalCard[];
  /** Parallel attempts from the current or most recent race. */
  lanes: LaneInfo[];
  /** How many lanes a bare race opens; 0 when this room cannot race. */
  laneCount: number;
  log: LogEntry[];
  /* Everything below is snapshot state a full-screen seat draws in its panes. */
  /** Approved prompts waiting for the model to free up. */
  queued: string[];
  micHolderId: string | null;
  runners: RunnerInfo[];
  activeRunnerId: string | null;
  turnCount: number;
  transcriptPath: string | null;
  policy: RoomPolicy;
  /** What the session is doing right now, e.g. the tool it is asking about. */
  agentDetail: string;
  model: string;
}

const MAX_LOG = 400;

export class RoomView {
  private state: ViewState = blank();
  private cards = new Map<string, ProposalCard>();
  private order: string[] = [];
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  setConnected(connected: boolean, encrypted: boolean): void {
    this.state.connected = connected;
    this.state.encrypted = encrypted;
  }

  setShareUrl(url: string): void {
    this.state.shareUrl = url;
  }

  /** The proposal a bare approve/veto should act on. */
  defaultProposalId(): string | null {
    const open = this.order.map((id) => this.cards.get(id)!).filter((c) => c?.open);
    // A tool vote is blocking the session right now, so it wins over a prompt.
    const tool = [...open].reverse().find((c) => c.proposal.kind === "tool");
    return (tool ?? open[open.length - 1])?.proposal.id ?? null;
  }

  snapshot(): ViewState {
    return {
      ...this.state,
      participants: [...this.state.participants],
      lanes: [...this.state.lanes],
      queued: [...this.state.queued],
      runners: [...this.state.runners],
      proposals: this.order.map((id) => this.cards.get(id)!).filter(Boolean).reverse(),
      log: this.state.log.slice(-MAX_LOG),
    };
  }

  apply(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome":
        this.state.youId = msg.you.id;
        this.state.youName = msg.you.name;
        this.absorb(msg.room);
        this.note("notice", `joined ${msg.room.name}`);
        return;

      case "snapshot":
        this.absorb(msg.room);
        return;

      case "presence":
        this.state.participants = msg.participants;
        if (msg.joined) this.note("notice", `${msg.joined} joined`);
        if (msg.left) this.note("notice", `${msg.left} left`);
        return;

      case "proposal":
      case "resolved": {
        const p = msg.proposal;
        const card: ProposalCard = {
          proposal: p,
          tally: msg.tally,
          progress:
            p.status === "open"
              ? renderTally(msg.tally, p.deadline, this.now())
              : `${p.status}${p.resolution ? ` — ${p.resolution}` : ""}`,
          open: p.status === "open",
        };
        if (!this.cards.has(p.id)) this.order.push(p.id);
        this.cards.set(p.id, card);
        return;
      }

      case "turnStart":
        // The room counts turns, but only tells us in a snapshot. Counting
        // along keeps the status bar honest between them.
        this.state.turnCount += 1;
        this.note("turn", `sending to the model (${msg.contributors.join(", ")})`);
        return;

      case "lanes":
        this.state.lanes = msg.lanes;
        this.state.laneCount = msg.laneCount;
        return;

      case "delta": {
        if (msg.kind !== "text") return;
        // A lane's output belongs to its lane, not to the room's transcript:
        // several agents writing at once would shred the reply in progress.
        if (msg.lane) return;
        // Append to the reply in progress rather than making a new entry per
        // token, or the panel becomes thousands of one-word paragraphs.
        const last = this.state.log[this.state.log.length - 1];
        if (last && last.kind === "model" && last.turnId === msg.turnId) {
          last.text += msg.text;
          return;
        }
        this.state.log.push({ kind: "model", text: msg.text, who: "", color: 0, at: this.now(), turnId: msg.turnId });
        this.trim();
        return;
      }

      case "toolResult":
        if (msg.lane) return;
        this.note("tool", `${msg.ok ? "✓" : "✗"} ${msg.preview.split("\n")[0]}`);
        return;

      case "turnEnd":
        if (msg.stopReason === "lanes") {
          this.note("turn", "lanes finished — the room votes on which one lands");
          return;
        }
        this.note("turn", msg.error ? `turn failed — ${msg.error}` : "turn complete");
        return;

      case "agent":
        this.state.agent = msg.status.state;
        this.state.agentDetail = msg.status.detail ?? "";
        if (msg.status.backend) this.state.backend = msg.status.backend;
        if (msg.status.model) this.state.model = msg.status.model;
        return;

      case "queued":
        this.state.queued = msg.proposalIds;
        return;

      case "runners":
        this.state.runners = msg.runners;
        this.state.activeRunnerId = msg.activeId;
        return;

      case "chat": {
        const who = this.state.participants.find((p) => p.id === msg.fromId);
        this.state.log.push({
          kind: "chat",
          text: msg.text,
          who: who?.name ?? msg.fromName,
          color: who?.color ?? 0,
          at: msg.at,
        });
        this.trim();
        return;
      }

      case "policy":
        this.state.policy = msg.policy;
        this.state.gate = describeGate(msg.policy.prompt);
        this.note("notice", `${msg.byName} changed the room's rules`);
        return;

      case "notice":
        this.note("notice", msg.text);
        return;

      case "error":
        this.note("notice", `✕ ${msg.text}`);
        return;

      default:
        return;
    }
  }

  private absorb(room: RoomSnapshot): void {
    this.state.room = room.name;
    this.state.cwd = room.cwd;
    this.state.gate = describeGate(room.policy.prompt);
    this.state.agent = room.agent.state;
    this.state.backend = room.agent.backend || this.state.backend;
    this.state.participants = room.participants;
    this.state.lanes = room.lanes;
    this.state.laneCount = room.laneCount;
    this.state.policy = room.policy;
    this.state.queued = room.queued;
    this.state.micHolderId = room.micHolderId;
    this.state.runners = room.runners;
    this.state.activeRunnerId = room.activeRunnerId;
    this.state.turnCount = room.turnCount;
    this.state.transcriptPath = room.transcriptPath;
    this.state.agentDetail = room.agent.detail ?? "";
    this.state.model = room.agent.model || this.state.model;
    for (const p of room.proposals) {
      if (!this.cards.has(p.id)) this.order.push(p.id);
      this.cards.set(p.id, {
        proposal: p,
        tally: null,
        progress: p.status === "open" ? "open" : `${p.status}${p.resolution ? ` — ${p.resolution}` : ""}`,
        open: p.status === "open",
      });
    }
  }

  private note(kind: EntryKind, text: string): void {
    this.state.log.push({ kind, text, who: "", color: 0, at: this.now() });
    this.trim();
  }

  private trim(): void {
    if (this.state.log.length > MAX_LOG * 2) {
      this.state.log = this.state.log.slice(-MAX_LOG);
    }
  }

  /** Short line for the status bar. */
  statusText(): string {
    if (!this.state.connected) return "$(circle-slash) multiplayer";
    const open = this.order.filter((id) => this.cards.get(id)?.open).length;
    const bits = [this.state.room || "room"];
    if (open) bits.push(`${open} pending`);
    else if (this.state.agent && this.state.agent !== "idle") bits.push(this.state.agent);
    return `$(organization) ${bits.join(" · ")}`;
  }

  /**
   * Put an already-formatted line in the transcript verbatim.
   *
   * The invite banner is laid out by the caller, escapes and indentation and
   * all. Wrapping it again would measure the escapes as visible width and
   * throw away the indentation that makes it readable.
   */
  raw(text: string): void {
    this.state.log.push({ kind: "raw", text, who: "", color: 0, at: this.now() });
    this.trim();
  }

  /** Drop the transcript, keeping the room. `/clear` in a full-screen seat. */
  clearLog(): void {
    this.state.log = [];
  }

  reset(): void {
    this.state = blank();
    this.cards.clear();
    this.order = [];
  }
}

function blank(): ViewState {
  return {
    connected: false,
    encrypted: false,
    room: "",
    backend: "",
    gate: "",
    agent: "idle",
    cwd: "",
    youId: "",
    youName: "",
    shareUrl: "",
    participants: [],
    proposals: [],
    lanes: [],
    laneCount: 0,
    log: [],
    queued: [],
    micHolderId: null,
    runners: [],
    activeRunnerId: null,
    turnCount: 0,
    transcriptPath: null,
    // A real policy arrives with the welcome; this only has to be renderable
    // in the moment before it does.
    policy: PRESETS.team!,
    agentDetail: "",
    model: "",
  };
}
