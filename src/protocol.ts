/**
 * Wire protocol for multiplayer-cli.
 *
 * One room server owns exactly one AI session. Every participant is a thin
 * client: it never talks to the model, it only proposes, votes, and renders.
 * That is what makes the session genuinely shared instead of N private ones.
 */

/**
 * 2 made room traffic end-to-end encrypted and stopped the token travelling in
 * the URL. 3 replaced the token-derived key with an ephemeral ECDH handshake,
 * so a leaked link cannot decrypt traffic recorded earlier. 4 added lanes:
 * proposals carry a lane count, and output carries the lane it came from.
 * 5 added crossroads, where the agent asks the room to pick a direction.
 * Older clients cannot talk to a v5 room.
 */
export const PROTOCOL_VERSION = 5;

export type Role = "owner" | "member" | "observer";
export type Vote = "yes" | "no" | "abstain";
export type ProposalKind = "prompt" | "tool" | "lane" | "choice";
export type ProposalStatus =
  | "open"
  | "approved"
  | "sent"
  | "rejected"
  | "withdrawn"
  | "expired";

/** How risky a tool call is, which decides whether it needs a vote at all. */
export type ToolRisk = "read" | "write" | "exec";

export type GateMode =
  | "open" // anything goes straight to the model
  | "owner" // the host decides
  | "majority" // more than half of the room
  | "quorum" // a fixed number of approvals
  | "consensus" // everyone present must say yes
  | "round-robin"; // only whoever holds the mic may prompt

export interface GatePolicy {
  mode: GateMode;
  /** Approvals needed in `quorum` mode. */
  quorum: number;
  /** A single "no" kills the proposal, regardless of mode. */
  veto: boolean;
  /** Silence-is-consent window in ms. `null` disables the timer entirely. */
  autoApproveMs: number | null;
  /** Minimum yes votes required when the timer fires. 0 = pure lazy consensus. */
  minYesOnTimeout: number;
  /** The proposer's own vote counts as yes automatically. */
  proposerAutoYes: boolean;
  /** When only one person is in the room, skip the ceremony. */
  soloBypass: boolean;
}

export interface RoomPolicy {
  /** Gate applied to prompts headed for the model. */
  prompt: GatePolicy;
  /** Gate applied to tool calls the model wants to make. */
  tool: GatePolicy;
  /** Gate applied to landing a lane's work in the repository. */
  lane: GatePolicy;
  /** Gate applied to ratifying a direction at a crossroads. */
  choice: GatePolicy;
  /** Tool risk levels that skip the vote entirely. */
  autoAllowToolRisks: ToolRisk[];
  /** Who may interrupt a running turn. */
  interrupt: "anyone" | "owner" | "proposer";
  /** Concatenate proposals approved while the model is busy into one turn. */
  mergeQueued: boolean;
  /** Prefix each turn with who wrote and who approved it. */
  attribute: boolean;
}

export interface Participant {
  id: string;
  name: string;
  /** Index into the client palette, so everyone sees the same colors. */
  color: number;
  role: Role;
  joinedAt: number;
  connected: boolean;
  typing: boolean;
}

export interface VoteRecord {
  vote: Vote;
  at: number;
  comment?: string;
}

export interface ToolRequest {
  toolUseId: string;
  name: string;
  input: unknown;
  risk: ToolRisk;
  /** One-line human summary, e.g. `bash: rm -rf build/`. */
  summary: string;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** Participant id, or `"agent"` for tool proposals. */
  authorId: string;
  authorName: string;
  text: string;
  tool?: ToolRequest;
  /** On a prompt: run it this many times in parallel lanes instead of once. */
  race?: number;
  /** On a lane proposal: which lane landing this would merge. */
  lane?: string;
  /** On a choice proposal: which crossroads option this would ratify. */
  option?: string;
  createdAt: number;
  /** Wall-clock ms after which the timer decides. `null` = no timer. */
  deadline: number | null;
  votes: Record<string, VoteRecord>;
  edits: { at: number; by: string; byName: string; from: string }[];
  status: ProposalStatus;
  resolvedAt?: number;
  /** Human-readable explanation of how it resolved. */
  resolution?: string;
}

export interface Tally {
  yes: number;
  no: number;
  abstain: number;
  /** Voters who have not weighed in yet. */
  pending: string[];
  electorate: number;
  /** Yes votes still needed, or 0 when already satisfied. */
  need: number;
  decision: "pending" | "approve" | "reject";
  reason: string;
}

export interface CrossroadsOption {
  /** Short and stable: a, b, c. */
  id: string;
  label: string;
  /** Why you would pick it, when the model bothered to say. */
  detail?: string;
  /** The proposal ratifying this option. */
  proposalId: string | null;
}

/**
 * A fork put to the room.
 *
 * Every other gate is the room interrupting the agent. This is the agent
 * stopping at a fork it cannot settle on its own — usually because the answer
 * is a decision rather than a fact — and asking which way to go before it
 * spends the work finding out.
 */
export interface CrossroadsInfo {
  id: string;
  question: string;
  /** Participant id, or `"agent"`. */
  askedById: string;
  askedByName: string;
  options: CrossroadsOption[];
  createdAt: number;
  /** The option the room ratified, once it has. */
  chosen: string | null;
  state: "open" | "decided" | "abandoned";
  /**
   * A turn is paused waiting for this answer.
   *
   * True only where the backend can actually be held mid-turn. A CLI that has
   * already streamed its output cannot be paused, so its crossroads is
   * answered in the next turn instead — and says so rather than pretending.
   */
  blocking: boolean;
}

/**
 * How a parallel attempt ended.
 *
 * `done` means it produced a commit the room can vote on; `empty` means the
 * agent finished without changing anything, which is an outcome, not a fault.
 */
export type LaneState = "running" | "done" | "empty" | "failed" | "landed" | "discarded";

/**
 * One attempt at the same prompt, in its own git worktree.
 *
 * Racing is the part the room cannot do by talking: several agents try the
 * same task at once on separate branches, and the room votes on which result
 * is the one that lands in the repository.
 */
export interface LaneInfo {
  /** Short and stable for a session: A, B, C. */
  id: string;
  turnId: string;
  branch: string;
  /** The lane's own checkout, so a seat can go and look at it. */
  dir: string;
  backend: string;
  state: LaneState;
  /** `3 files changed, +42 -7`, once the lane has committed. */
  summary: string;
  /** Per-file diffstat, for reading before voting. */
  detail: string;
  commit: string | null;
  error?: string;
  /** The proposal the room votes on to land this lane, once it has one. */
  proposalId: string | null;
  startedAt: number;
  endedAt: number | null;
}

/**
 * A seat that can execute turns on its own machine, under its own login.
 *
 * The room's conversation is shared; the compute behind it does not have to be.
 * A runner spends its owner's subscription, so no single account carries a
 * whole room and a usage limit is a handoff rather than a dead stop.
 */
export interface RunnerInfo {
  /** Participant id, or `"local"` for the host's own in-process backend. */
  id: string;
  name: string;
  backend: string;
  /** The runner's own working directory — tools act on *their* checkout. */
  cwd: string;
  busy: boolean;
  /** Reported a usage or rate limit; skipped until it clears. */
  exhausted: boolean;
  /** When the limit is expected to lift, if the tool said so. */
  exhaustedUntil: number | null;
  /** Turns this runner has taken for the room. */
  turns: number;
  local: boolean;
}

export interface AgentStatus {
  state: "idle" | "thinking" | "streaming" | "tool" | "error";
  turnId: string | null;
  /** Model identifier or backend name, for the status bar. */
  model: string;
  backend: string;
  detail?: string;
}

export interface RoomSnapshot {
  roomId: string;
  name: string;
  cwd: string;
  policy: RoomPolicy;
  participants: Participant[];
  proposals: Proposal[];
  agent: AgentStatus;
  /** Approved prompts waiting for the model to free up. */
  queued: string[];
  micHolderId: string | null;
  transcriptPath: string | null;
  turnCount: number;
  runners: RunnerInfo[];
  /** Whoever ran the last turn, and will run the next one unless they cannot. */
  activeRunnerId: string | null;
  /** Parallel attempts from the current or most recent race. */
  lanes: LaneInfo[];
  /** Lanes a bare `/race` opens. 0 when this room cannot race at all. */
  laneCount: number;
  /** The fork the room is deciding, if there is one. */
  crossroads: CrossroadsInfo | null;
}

/* ------------------------------------------------------------------ */
/* client -> server                                                    */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | { t: "hello"; name: string; token?: string; protocol: number; observer?: boolean }
  /* `race` runs the prompt in that many parallel lanes; 0 means the room's default. */
  | { t: "propose"; text: string; race?: number }
  | { t: "vote"; proposalId: string; vote: Vote; comment?: string }
  | { t: "amend"; proposalId: string; text: string }
  | { t: "withdraw"; proposalId: string }
  | { t: "chat"; text: string }
  | { t: "typing"; typing: boolean }
  | { t: "interrupt" }
  | { t: "setPolicy"; patch: unknown }
  | { t: "rename"; name: string }
  | { t: "passMic"; toId: string }
  /* Change how many lanes a bare `/race` opens (host only). */
  | { t: "setLanes"; count: number }
  /* Put a fork to the room yourself, rather than waiting for the agent to. */
  | { t: "ask"; question: string; options: string[] }
  | { t: "sync" }
  | { t: "ping" }
  /* A seat offering its own machine and subscription to the room. */
  | { t: "runner"; backend: string; cwd: string }
  | { t: "runnerGone" }
  | { t: "runOut"; turnId: string; kind: "text" | "thinking"; text: string }
  | { t: "runTool"; turnId: string; toolUseId: string; ok: boolean; preview: string }
  | { t: "runNotice"; turnId: string; text: string }
  | {
      t: "runEnd";
      turnId: string;
      stopReason: string;
      usage?: Record<string, number>;
      error?: string;
      /** The turn failed because this account is out of capacity, not broken. */
      limited?: boolean;
      /** When the limit lifts, if the tool said so. */
      until?: number | null;
    };

/* ------------------------------------------------------------------ */
/* server -> client                                                    */
/* ------------------------------------------------------------------ */

export type ServerMessage =
  | { t: "welcome"; you: Participant; room: RoomSnapshot; motd?: string }
  | { t: "snapshot"; room: RoomSnapshot }
  | { t: "presence"; participants: Participant[]; joined?: string; left?: string }
  | { t: "proposal"; proposal: Proposal; tally: Tally; event: "new" | "vote" | "amend" }
  | { t: "resolved"; proposal: Proposal; tally: Tally }
  | { t: "queued"; proposalIds: string[] }
  | { t: "turnStart"; turnId: string; prompt: string; contributors: string[] }
  | { t: "delta"; turnId: string; kind: "text" | "thinking"; text: string; lane?: string }
  | { t: "toolResult"; turnId: string; toolUseId: string; ok: boolean; preview: string; lane?: string }
  | { t: "turnEnd"; turnId: string; stopReason: string; usage?: Record<string, number>; error?: string }
  | { t: "agent"; status: AgentStatus }
  | { t: "chat"; fromId: string; fromName: string; text: string; at: number }
  | { t: "policy"; policy: RoomPolicy; byName: string }
  | { t: "notice"; level: "info" | "warn" | "error"; text: string }
  | { t: "runners"; runners: RunnerInfo[]; activeId: string | null }
  | { t: "lanes"; lanes: LaneInfo[]; laneCount: number }
  | { t: "crossroads"; crossroads: CrossroadsInfo | null }
  /* Sent only to the seat that is being asked to run this turn. */
  | { t: "runTurn"; turnId: string; prompt: string }
  | { t: "runCancel"; turnId: string }
  | { t: "error"; text: string }
  | { t: "pong" };

export function encode(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg);
}

/** Parse a frame, returning `null` rather than throwing on garbage. */
export function decode<T extends ClientMessage | ServerMessage>(raw: string): T | null {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && typeof v.t === "string") return v as T;
    return null;
  } catch {
    return null;
  }
}
