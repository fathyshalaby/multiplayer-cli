import { EventEmitter } from "node:events";
import type {
  AgentStatus,
  CrossroadsInfo,
  CrossroadsOption,
  GatePolicy,
  LaneInfo,
  Participant,
  Proposal,
  ProposalKind,
  Role,
  RoomPolicy,
  RoomSnapshot,
  ServerMessage,
  Tally,
  ToolRequest,
  Vote,
} from "../protocol.js";
import type { RunnerInfo } from "../protocol.js";
import { evaluate, type GateContext } from "./gate.js";
import { Counter, id } from "../util/id.js";
import { clonePolicy } from "./policy.js";

/** A ceiling on parallel attempts: every lane is a real agent and real spend. */
export const MAX_LANES = 6;

/** Option labels, short enough to say out loud. */
const LETTERS = ["a", "b", "c", "d", "e", "f"];

/** For turns the room has already decided; the gate would only be ceremony. */
const OPEN_GATE: GatePolicy = {
  mode: "open",
  quorum: 1,
  veto: false,
  autoApproveMs: null,
  minYesOnTimeout: 0,
  proposerAutoYes: false,
  soloBypass: true,
};

export interface RoomOptions {
  name: string;
  cwd: string;
  policy: RoomPolicy;
  transcriptPath?: string | null;
  /** Injectable clock so tests do not have to sleep. */
  now?: () => number;
}

export interface JoinRequest {
  name: string;
  role: Role;
  connectionId: string;
}

/**
 * The room is the single source of truth. It owns participants, proposals and
 * the decision timers; it emits what the server should broadcast and what the
 * agent should do next. It never touches sockets or the model directly, which
 * is what makes it testable end to end without either.
 */
export class Room extends EventEmitter {
  readonly roomId = id("room");
  readonly name: string;
  readonly cwd: string;
  policy: RoomPolicy;
  transcriptPath: string | null;

  private participants = new Map<string, Participant>();
  private proposals = new Map<string, Proposal>();
  private order: string[] = [];
  private counter = new Counter();
  private timers = new Map<string, NodeJS.Timeout>();
  private ownerId: string | null = null;
  private micIdx = 0;
  private queue: string[] = [];
  private nowFn: () => number;
  private colorSeq = 0;
  private agentStatus: AgentStatus = {
    state: "idle",
    turnId: null,
    model: "",
    backend: "",
  };
  turnCount = 0;
  /** Populated by the server from the routed backend, for display only. */
  runners: RunnerInfo[] = [];
  activeRunnerId: string | null = null;
  /** Parallel attempts from the current or most recent race, for display. */
  lanes: LaneInfo[] = [];
  /** Lanes a bare `/race` opens. 0 means this room cannot race at all. */
  laneCount = 0;
  /** The fork the room is deciding, if there is one. One at a time. */
  crossroads: CrossroadsInfo | null = null;
  /** Set false on close so late timers cannot resurrect a dead room. */
  private alive = true;

  constructor(opts: RoomOptions) {
    super();
    this.name = opts.name;
    this.cwd = opts.cwd;
    this.policy = clonePolicy(opts.policy);
    this.transcriptPath = opts.transcriptPath ?? null;
    this.nowFn = opts.now ?? (() => Date.now());
  }

  private now(): number {
    return this.nowFn();
  }

  /* ---------------------------------------------------------------- */
  /* participants                                                      */
  /* ---------------------------------------------------------------- */

  join(req: JoinRequest): Participant {
    const name = this.uniqueName(req.name);
    const p: Participant = {
      id: req.connectionId,
      name,
      color: this.colorSeq++,
      role: req.role,
      joinedAt: this.now(),
      connected: true,
      typing: false,
    };
    if (p.role === "owner") this.ownerId = p.id;
    this.participants.set(p.id, p);
    this.emitMsg({ t: "presence", participants: this.list(), joined: p.name });
    // A new voter changes every open tally, and may unblock a consensus vote.
    this.reevaluateAll();
    return p;
  }

  leave(pid: string): void {
    const p = this.participants.get(pid);
    if (!p) return;
    this.participants.delete(pid);
    this.emitMsg({ t: "presence", participants: this.list(), left: p.name });
    if (this.ownerId === pid) this.promoteNewOwner();
    // Their pending proposals go with them; their cast votes are simply ignored
    // by the gate, which recomputes the electorate from who is still here.
    for (const prop of this.openProposals()) {
      if (prop.kind === "prompt" && prop.authorId === pid) {
        this.resolve(prop, "withdrawn", `${p.name} left`);
      }
    }
    this.reevaluateAll();
  }

  private promoteNewOwner(): void {
    const next = [...this.participants.values()]
      .filter((p) => p.role !== "observer")
      .sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) {
      next.role = "owner";
      this.ownerId = next.id;
      this.notice("info", `${next.name} is now the host`);
    } else {
      this.ownerId = null;
    }
  }

  private uniqueName(want: string): string {
    const base = (want || "anon").replace(/\s+/g, "-").slice(0, 24);
    const taken = new Set([...this.participants.values()].map((p) => p.name));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 100; i++) {
      const candidate = `${base}${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base}-${id("x", 4)}`;
  }

  rename(pid: string, name: string): void {
    const p = this.participants.get(pid);
    if (!p) return;
    const old = p.name;
    p.name = this.uniqueName(name);
    for (const prop of this.proposals.values()) {
      if (prop.authorId === pid) prop.authorName = p.name;
    }
    this.notice("info", `${old} is now ${p.name}`);
    this.emitMsg({ t: "presence", participants: this.list() });
  }

  setTyping(pid: string, typing: boolean): void {
    const p = this.participants.get(pid);
    if (!p || p.typing === typing) return;
    p.typing = typing;
    this.emitMsg({ t: "presence", participants: this.list() });
  }

  get(pid: string): Participant | undefined {
    return this.participants.get(pid);
  }

  list(): Participant[] {
    return [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  get owner(): string | null {
    return this.ownerId;
  }

  /* ---------------------------------------------------------------- */
  /* proposals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * A participant suggests something to send to the model.
   *
   * `race` asks for the prompt to be attempted that many times in parallel,
   * each in its own worktree. The room still votes on sending it — racing
   * changes what happens after approval, not who gets to ask.
   */
  propose(pid: string, text: string, race?: number): Proposal | { error: string } {
    const p = this.participants.get(pid);
    if (!p) return { error: "you are not in this room" };
    if (p.role === "observer") return { error: "observers cannot propose" };
    const body = text.trim();
    if (!body) return { error: "empty proposal" };

    const gate = this.policy.prompt;
    if (gate.mode === "round-robin") {
      const holder = this.micHolder();
      if (holder && holder.id !== pid) {
        return { error: `${holder.name} holds the mic — /pass to hand it over` };
      }
    }

    if (race !== undefined) {
      if (!this.laneCount) return { error: "this room cannot race — it is not hosted in a git repository" };
      if (!Number.isInteger(race) || race < 2) return { error: "a race needs at least 2 lanes" };
      if (race > MAX_LANES) return { error: `at most ${MAX_LANES} lanes` };
    }
    return this.create("prompt", pid, p.name, body, gate, undefined, race);
  }

  /**
   * Put a finished lane to the room: land this attempt, or not.
   *
   * Authored by `agent` like a tool call, because nobody proposed it — the
   * race did. That also keeps `proposerAutoYes` from quietly voting for the
   * person who started the race on every lane at once.
   */
  proposeLane(lane: LaneInfo): Proposal {
    const text = `land lane ${lane.id} — ${lane.summary}`;
    return this.create("lane", "agent", "race", text, this.policy.lane, undefined, undefined, lane.id);
  }

  /**
   * Put a fork to the room.
   *
   * One option, one proposal — which means a choice among several reuses the
   * whole yes/no voting system rather than needing arithmetic of its own. The
   * first option to reach its threshold wins and the rest close, exactly as
   * lanes do.
   */
  ask(
    askedById: string,
    askedByName: string,
    question: string,
    options: { label: string; detail?: string }[],
    blocking: boolean,
  ): CrossroadsInfo | { error: string } {
    if (this.crossroads && this.crossroads.state === "open") {
      return { error: "the room is already deciding one fork — settle that first" };
    }
    const text = question.trim();
    if (!text) return { error: "a crossroads needs a question" };
    const picked = options.filter((o) => o.label.trim()).slice(0, LETTERS.length);
    if (picked.length < 2) return { error: "a crossroads needs at least two options" };

    const info: CrossroadsInfo = {
      id: id("fork", 6),
      question: text,
      askedById,
      askedByName,
      options: [],
      createdAt: this.now(),
      chosen: null,
      state: "open",
      blocking,
    };
    this.crossroads = info;

    for (const [i, opt] of picked.entries()) {
      const option: CrossroadsOption = {
        id: LETTERS[i]!,
        label: opt.label.trim(),
        ...(opt.detail?.trim() ? { detail: opt.detail.trim() } : {}),
        proposalId: null,
      };
      info.options.push(option);
      const prop = this.create(
        "choice",
        "agent",
        askedByName,
        `${option.id}. ${option.label}`,
        this.policy.choice,
        undefined,
        undefined,
        undefined,
        option.id,
      );
      option.proposalId = prop.id;
    }
    this.emitMsg({ t: "crossroads", crossroads: info });
    return info;
  }

  /** Ratify one option and close the others. */
  settleCrossroads(optionId: string, reason: string): void {
    const info = this.crossroads;
    if (!info || info.state !== "open") return;
    info.chosen = optionId;
    info.state = "decided";
    for (const prop of this.openProposals()) {
      if (prop.kind === "choice" && prop.option !== optionId) {
        this.resolve(prop, "withdrawn", reason);
      }
    }
    this.emitMsg({ t: "crossroads", crossroads: info });
  }

  /** Nobody picked. The fork closes without an answer, which is also an answer. */
  abandonCrossroads(reason: string): void {
    const info = this.crossroads;
    if (!info || info.state !== "open") return;
    info.state = "abandoned";
    for (const prop of this.openProposals()) {
      if (prop.kind === "choice") this.resolve(prop, "withdrawn", reason);
    }
    this.emitMsg({ t: "crossroads", crossroads: info });
  }

  /** The option a proposal ratifies, if it is a choice proposal. */
  optionFor(p: Proposal): CrossroadsOption | undefined {
    return this.crossroads?.options.find((o) => o.id === p.option);
  }

  /**
   * Send something to the model without another vote.
   *
   * Used to carry a crossroads answer back to a backend that could not be held
   * mid-turn: the room has already voted on the direction, and making it vote
   * again on the sentence conveying that vote would be ceremony for its own
   * sake.
   */
  injectTurn(text: string, authorName: string): void {
    const prop = this.create("prompt", "agent", authorName, text, OPEN_GATE);
    if (prop.status === "open") {
      prop.status = "approved";
      prop.resolvedAt = this.now();
      prop.resolution = "the room already decided this";
      this.clearTimer(prop.id);
      this.queue.push(prop.id);
      this.emitMsg({ t: "queued", proposalIds: [...this.queue] });
      this.emit("promptReady");
    }
  }

  /**
   * Close the lanes that lost. Called once a landing has actually succeeded,
   * not when it is merely approved: a merge that hits a conflict leaves the
   * other attempts on the table rather than throwing them away.
   */
  closeOtherLanes(winner: string, reason: string): void {
    for (const prop of this.openProposals()) {
      if (prop.kind === "lane" && prop.lane !== winner) this.resolve(prop, "withdrawn", reason);
    }
  }

  /** The model wants to run a tool; the room decides whether it may. */
  proposeTool(req: ToolRequest): Proposal {
    return this.create("tool", "agent", "claude", req.summary, this.policy.tool, req) as Proposal;
  }

  private create(
    kind: ProposalKind,
    authorId: string,
    authorName: string,
    text: string,
    gate: GatePolicy,
    tool?: ToolRequest,
    race?: number,
    lane?: string,
    option?: string,
  ): Proposal {
    const prop: Proposal = {
      id: this.counter.next(),
      kind,
      authorId,
      authorName,
      text,
      tool,
      ...(race ? { race } : {}),
      ...(lane ? { lane } : {}),
      ...(option ? { option } : {}),
      createdAt: this.now(),
      deadline: gate.autoApproveMs === null ? null : this.now() + gate.autoApproveMs,
      votes: {},
      edits: [],
      status: "open",
    };
    this.proposals.set(prop.id, prop);
    this.order.push(prop.id);
    this.emitMsg({ t: "proposal", proposal: prop, tally: this.tally(prop), event: "new" });
    this.arm(prop);
    // Evaluate immediately: `open` rooms, solo sessions and round-robin all
    // resolve on the spot, and there is no reason to make them wait a tick.
    this.check(prop);
    return prop;
  }

  vote(pid: string, proposalId: string, vote: Vote, comment?: string): string | null {
    const p = this.participants.get(pid);
    if (!p) return "you are not in this room";
    if (p.role === "observer") return "observers cannot vote";
    const prop = this.resolveHandle(proposalId);
    if (!prop) return `no such proposal ${proposalId}`;
    if (prop.status !== "open") return `${prop.id} is already ${prop.status}`;

    prop.votes[pid] = { at: this.now(), vote, ...(comment ? { comment } : {}) };
    this.emitMsg({ t: "proposal", proposal: prop, tally: this.tally(prop), event: "vote" });
    this.check(prop);
    return null;
  }

  amend(pid: string, proposalId: string, text: string): string | null {
    const p = this.participants.get(pid);
    if (!p) return "you are not in this room";
    const prop = this.resolveHandle(proposalId);
    if (!prop) return `no such proposal ${proposalId}`;
    if (prop.status !== "open") return `${prop.id} is already ${prop.status}`;
    if (prop.kind === "tool") return "tool calls cannot be amended — approve or reject";
    if (prop.authorId !== pid && p.role !== "owner") return `only ${prop.authorName} or the host can amend ${prop.id}`;
    const body = text.trim();
    if (!body) return "empty amendment";

    prop.edits.push({ at: this.now(), by: pid, byName: p.name, from: prop.text });
    prop.text = body;
    // An amendment invalidates consent given to the previous wording.
    prop.votes = {};
    const gate = this.policy.prompt;
    prop.deadline = gate.autoApproveMs === null ? null : this.now() + gate.autoApproveMs;
    this.arm(prop);
    this.emitMsg({ t: "proposal", proposal: prop, tally: this.tally(prop), event: "amend" });
    this.check(prop);
    return null;
  }

  withdraw(pid: string, proposalId: string): string | null {
    const p = this.participants.get(pid);
    if (!p) return "you are not in this room";
    const prop = this.resolveHandle(proposalId);
    if (!prop) return `no such proposal ${proposalId}`;
    if (prop.status !== "open") return `${prop.id} is already ${prop.status}`;
    if (prop.authorId !== pid && p.role !== "owner") return `only ${prop.authorName} or the host can withdraw ${prop.id}`;
    this.resolve(prop, "withdrawn", `withdrawn by ${p.name}`);
    return null;
  }

  /** Accept `#3`, `3`, or the empty string meaning "the newest open one". */
  resolveHandle(handle: string): Proposal | undefined {
    const h = handle.trim();
    if (!h) return this.newestOpen();
    const key = h.startsWith("#") ? h : `#${h}`;
    return this.proposals.get(key);
  }

  newestOpen(kind?: ProposalKind): Proposal | undefined {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const p = this.proposals.get(this.order[i]!);
      if (p && p.status === "open" && (!kind || p.kind === kind)) return p;
    }
    return undefined;
  }

  openProposals(): Proposal[] {
    return this.order
      .map((k) => this.proposals.get(k)!)
      .filter((p) => p && p.status === "open");
  }

  tally(p: Proposal): Tally {
    return evaluate(p, this.gateFor(p), this.ctx());
  }

  private gateFor(p: Proposal): GatePolicy {
    if (p.kind === "tool") return this.policy.tool;
    if (p.kind === "lane") return this.policy.lane;
    if (p.kind === "choice") return this.policy.choice;
    return this.policy.prompt;
  }

  private ctx(): GateContext {
    return {
      participants: this.list(),
      ownerId: this.ownerId,
      micHolderId: this.micHolder()?.id ?? null,
      now: this.now(),
    };
  }

  private arm(p: Proposal): void {
    const existing = this.timers.get(p.id);
    if (existing) clearTimeout(existing);
    if (p.deadline === null) return;
    const delay = Math.max(0, p.deadline - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(p.id);
      if (!this.alive) return;
      const current = this.proposals.get(p.id);
      if (!current || current.status !== "open") return;
      // setTimeout may fire a millisecond early. Re-arm rather than evaluate,
      // or the gate reads "not expired yet" and the vote hangs forever.
      if (current.deadline !== null && this.now() < current.deadline) {
        this.arm(current);
        return;
      }
      this.check(current);
    }, delay);
    // A pending vote should never be the reason a process refuses to exit.
    timer.unref?.();
    this.timers.set(p.id, timer);
  }

  private check(p: Proposal): void {
    if (p.status !== "open") return;
    const t = this.tally(p);
    if (t.decision === "pending") return;
    if (t.decision === "approve") this.approve(p, t);
    else this.resolve(p, "rejected", t.reason);
  }

  /** Recompute every open vote — call whenever the electorate changes. */
  private reevaluateAll(): void {
    for (const p of this.openProposals()) this.check(p);
  }

  private approve(p: Proposal, t: Tally): void {
    p.status = "approved";
    p.resolvedAt = this.now();
    p.resolution = t.reason;
    this.clearTimer(p.id);
    this.emitMsg({ t: "resolved", proposal: p, tally: t });

    if (p.kind === "tool") {
      this.emit("toolDecision", p, true, t.reason);
      return;
    }
    if (p.kind === "lane") {
      this.emit("laneDecision", p, true, t.reason);
      return;
    }
    if (p.kind === "choice") {
      this.emit("choiceDecision", p, true, t.reason);
      return;
    }
    this.queue.push(p.id);
    this.emitMsg({ t: "queued", proposalIds: [...this.queue] });
    if (this.policy.prompt.mode === "round-robin") this.advanceMic();
    this.emit("promptReady");
  }

  private resolve(p: Proposal, status: Proposal["status"], reason: string): void {
    p.status = status;
    p.resolvedAt = this.now();
    p.resolution = reason;
    this.clearTimer(p.id);
    const t = this.tally(p);
    this.emitMsg({ t: "resolved", proposal: p, tally: { ...t, decision: "reject", reason } });
    if (p.kind === "tool") this.emit("toolDecision", p, false, reason);
    if (p.kind === "lane") this.emit("laneDecision", p, false, reason);
    if (p.kind === "choice") this.emit("choiceDecision", p, false, reason);
  }

  private clearTimer(pid: string): void {
    const timer = this.timers.get(pid);
    if (timer) clearTimeout(timer);
    this.timers.delete(pid);
  }

  /* ---------------------------------------------------------------- */
  /* the send queue                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Pull the next turn's worth of approved prompts. With `mergeQueued` the
   * whole backlog goes in one turn, so three people who all approved while the
   * model was busy get one coherent answer instead of three interleaved ones.
   */
  takeQueued(): Proposal[] {
    if (!this.queue.length) return [];
    const ids = this.queue.splice(0, this.batchSize());
    this.emitMsg({ t: "queued", proposalIds: [...this.queue] });
    const out: Proposal[] = [];
    for (const qid of ids) {
      const p = this.proposals.get(qid);
      if (!p) continue;
      p.status = "sent";
      out.push(p);
    }
    return out;
  }

  /**
   * How much of the backlog the next turn takes.
   *
   * A race is always alone in its turn: it forks the repository N ways, and
   * folding somebody's unrelated question into that would put the same
   * question to N agents and land one arbitrary answer.
   */
  private batchSize(): number {
    if (this.proposals.get(this.queue[0]!)?.race) return 1;
    if (!this.policy.mergeQueued) return 1;
    let n = 1;
    while (n < this.queue.length && !this.proposals.get(this.queue[n]!)?.race) n++;
    return n;
  }

  queuedIds(): string[] {
    return [...this.queue];
  }

  /** Render approved proposals into the text the model actually receives. */
  composeTurn(props: Proposal[]): string {
    if (!this.policy.attribute) return props.map((p) => p.text).join("\n\n");
    return props
      .map((p) => {
        const approvers = Object.entries(p.votes)
          .filter(([, v]) => v.vote === "yes")
          .map(([pid]) => this.participants.get(pid)?.name)
          .filter(Boolean) as string[];
        const seen = new Set(approvers);
        if (!seen.has(p.authorName)) approvers.unshift(p.authorName);
        const head = `[${p.authorName}${approvers.length > 1 ? `, approved by ${approvers.filter((a) => a !== p.authorName).join(", ")}` : ""}]`;
        return `${head} ${p.text}`;
      })
      .join("\n\n");
  }

  /* ---------------------------------------------------------------- */
  /* mic (round-robin mode)                                            */
  /* ---------------------------------------------------------------- */

  micHolder(): Participant | undefined {
    const eligible = this.list().filter((p) => p.connected && p.role !== "observer");
    if (!eligible.length) return undefined;
    return eligible[this.micIdx % eligible.length];
  }

  advanceMic(): void {
    const eligible = this.list().filter((p) => p.connected && p.role !== "observer");
    if (eligible.length <= 1) return;
    this.micIdx = (this.micIdx + 1) % eligible.length;
    const holder = this.micHolder();
    if (holder) this.notice("info", `${holder.name} has the mic`);
  }

  passMic(fromId: string, toId: string): string | null {
    const holder = this.micHolder();
    if (holder && holder.id !== fromId && this.ownerId !== fromId) return "you do not hold the mic";
    const eligible = this.list().filter((p) => p.connected && p.role !== "observer");
    const idx = eligible.findIndex((p) => p.id === toId || p.name === toId);
    if (idx < 0) return `no such participant ${toId}`;
    this.micIdx = idx;
    this.notice("info", `${eligible[idx]!.name} has the mic`);
    this.emitMsg({ t: "snapshot", room: this.snapshot() });
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* policy + agent status                                             */
  /* ---------------------------------------------------------------- */

  setPolicy(pid: string, policy: RoomPolicy): string | null {
    const p = this.participants.get(pid);
    if (!p) return "you are not in this room";
    if (p.role !== "owner") return "only the host can change the policy";
    this.policy = clonePolicy(policy);
    this.emitMsg({ t: "policy", policy: this.policy, byName: p.name });
    // Re-arm open votes so a loosened or tightened rule takes effect now.
    for (const prop of this.openProposals()) {
      const gate = this.gateFor(prop);
      prop.deadline = gate.autoApproveMs === null ? null : this.now() + gate.autoApproveMs;
      this.arm(prop);
      this.check(prop);
    }
    return null;
  }

  canInterrupt(pid: string): boolean {
    const p = this.participants.get(pid);
    if (!p || p.role === "observer") return false;
    switch (this.policy.interrupt) {
      case "anyone":
        return true;
      case "owner":
        return p.role === "owner";
      case "proposer":
        return p.role === "owner" || this.lastTurnAuthors.has(pid);
    }
  }

  lastTurnAuthors = new Set<string>();

  setAgent(status: Partial<AgentStatus>): void {
    this.agentStatus = { ...this.agentStatus, ...status };
    this.emitMsg({ t: "agent", status: this.agentStatus });
  }

  get agent(): AgentStatus {
    return this.agentStatus;
  }

  notice(level: "info" | "warn" | "error", text: string): void {
    this.emitMsg({ t: "notice", level, text });
  }

  snapshot(): RoomSnapshot {
    // Keep the tail of resolved proposals so a late joiner sees recent history
    // without replaying the whole session.
    const recent = this.order.slice(-40).map((k) => this.proposals.get(k)!).filter(Boolean);
    return {
      roomId: this.roomId,
      name: this.name,
      cwd: this.cwd,
      policy: this.policy,
      participants: this.list(),
      proposals: recent,
      agent: this.agentStatus,
      queued: [...this.queue],
      micHolderId: this.micHolder()?.id ?? null,
      transcriptPath: this.transcriptPath,
      turnCount: this.turnCount,
      runners: this.runners,
      activeRunnerId: this.activeRunnerId,
      lanes: this.lanes,
      laneCount: this.laneCount,
      crossroads: this.crossroads,
    };
  }

  close(): void {
    this.alive = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private emitMsg(msg: ServerMessage): void {
    this.emit("broadcast", msg);
  }
}
