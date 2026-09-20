/**
 * The governance kernel, as a library — not the CLI, not the room server,
 * just the pure decision logic behind "several people share one AI agent
 * and nothing happens until they agree."
 *
 * `mpx` itself is `core/gate.ts` wired to a WebSocket room and an AI
 * backend. Someone building their own multiplayer AI product — a different
 * UI, a different transport, a different kind of agent entirely — doesn't
 * need any of that; they need `evaluate()`. It has no dependency beyond
 * plain types, no clock of its own (`now` is a parameter, not a call to
 * `Date.now()`), and no I/O, which is exactly what makes it safe to embed
 * in someone else's process rather than only runnable inside this one.
 *
 * `multiplayer-cloud`'s hosted consent API (a room/proposal/vote HTTP
 * service for people who would rather call an endpoint than run this
 * themselves) is built on this exact export — not a reimplementation of it.
 * See that repo's ARCHITECTURE.md for the "component vs. hosted service"
 * split this is meant to support.
 *
 * Stability note: this is a new surface (added alongside the CLI, which
 * remains the primary product) and may still move before a 1.0. The
 * underlying algorithm is exactly what backs every room `mpx share` opens,
 * so its *behavior* is exactly as tested as the CLI itself — gate.test.ts
 * covers every voting rule, one test each.
 */
export { evaluate, electorate, renderTally, type GateContext } from "./core/gate.js";
export {
  PRESETS,
  DEFAULT_PRESET,
  presetNames,
  clonePolicy,
  resolvePreset,
  applyOverrides,
  parseDuration,
  describeGate,
} from "./core/policy.js";
export type {
  GateMode,
  GatePolicy,
  RoomPolicy,
  Vote,
  VoteRecord,
  Participant,
  Role,
  Proposal,
  ProposalKind,
  ProposalStatus,
  Tally,
  ToolRequest,
  ToolRisk,
} from "./protocol.js";
