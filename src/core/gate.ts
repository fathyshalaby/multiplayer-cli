import type { GatePolicy, Participant, Proposal, Tally } from "../protocol.js";

/**
 * Who is entitled to vote right now: connected, non-observer participants.
 *
 * Deliberately recomputed per evaluation rather than frozen at proposal time.
 * If someone drops off mid-vote, a consensus room should not deadlock waiting
 * for a laptop that closed.
 */
export function electorate(participants: Participant[]): Participant[] {
  return participants.filter((p) => p.connected && p.role !== "observer");
}

export interface GateContext {
  participants: Participant[];
  ownerId: string | null;
  micHolderId: string | null;
  now: number;
}

/**
 * Decide the fate of a proposal. Pure: same inputs, same answer, no clocks of
 * its own. The caller supplies `now` so timers are testable and so the server
 * and the transcript replay agree.
 */
export function evaluate(p: Proposal, policy: GatePolicy, ctx: GateContext): Tally {
  const voters = electorate(ctx.participants);
  const eligible = voters.filter((v) => v.id !== "agent");
  const ids = new Set(eligible.map((v) => v.id));

  let yes = 0;
  let no = 0;
  let abstain = 0;
  const voted = new Set<string>();

  for (const [id, rec] of Object.entries(p.votes)) {
    if (!ids.has(id)) continue; // stale vote from someone who left
    voted.add(id);
    if (rec.vote === "yes") yes++;
    else if (rec.vote === "no") no++;
    else abstain++;
  }

  // The author of a prompt is presumed to want it sent — the author of the
  // *current wording*, that is. When the host amends someone else's proposal,
  // `amend` clears every vote because consent was given to different words,
  // and presuming the original author still wants the host's version would
  // quietly hand that consent straight back. The person who wrote these words
  // is presumed to want them; the original author has to say so.
  const presumed = presumedAuthor(p);
  if (policy.proposerAutoYes && ids.has(presumed) && !voted.has(presumed)) {
    yes++;
    voted.add(presumed);
  }

  const pending = eligible.filter((v) => !voted.has(v.id)).map((v) => v.id);
  const n = eligible.length;
  const base = { yes, no, abstain, pending, electorate: n };

  const timedOut = p.deadline !== null && ctx.now >= p.deadline;

  // A veto is absolute and immediate wherever it is enabled.
  if (policy.veto && no > 0) {
    return { ...base, need: 0, decision: "reject", reason: vetoReason(p, ids) };
  }

  if (n === 0) {
    // Everyone disconnected. Hold rather than send something unattended.
    return { ...base, need: 1, decision: "pending", reason: "nobody is connected" };
  }

  if (policy.soloBypass && n === 1 && p.kind === "prompt") {
    return { ...base, need: 0, decision: "approve", reason: "solo session" };
  }

  switch (policy.mode) {
    case "open":
      return { ...base, need: 0, decision: "approve", reason: "open room" };

    case "round-robin": {
      if (p.kind !== "prompt") break; // tools fall through to the shared logic
      if (ctx.micHolderId && p.authorId !== ctx.micHolderId) {
        return { ...base, need: 0, decision: "reject", reason: "not your turn at the mic" };
      }
      return { ...base, need: 0, decision: "approve", reason: "holds the mic" };
    }

    case "owner": {
      const owner = ctx.ownerId;
      if (!owner || !ids.has(owner)) {
        return { ...base, need: 1, decision: "pending", reason: "waiting for the host to reconnect" };
      }
      const ov = p.votes[owner]?.vote ?? (policy.proposerAutoYes && presumed === owner ? "yes" : null);
      if (ov === "yes") return { ...base, need: 0, decision: "approve", reason: "approved by the host" };
      if (ov === "no") return { ...base, need: 0, decision: "reject", reason: "declined by the host" };
      return decideOnTimer(base, policy, p, timedOut, 1, "waiting for the host");
    }
  }

  const needed = requiredYes(policy, n);
  if (yes >= needed) {
    return { ...base, need: 0, decision: "approve", reason: `${yes}/${needed} approvals` };
  }

  // Once enough people have said no, the threshold is unreachable — fail fast
  // instead of making the room wait out a timer that cannot change anything.
  const stillPossible = n - no;
  if (stillPossible < needed) {
    return { ...base, need: needed - yes, decision: "reject", reason: `${needed} approvals no longer reachable` };
  }

  return decideOnTimer(base, policy, p, timedOut, needed - yes, `${yes}/${needed} approvals`);
}

function requiredYes(policy: GatePolicy, n: number): number {
  switch (policy.mode) {
    case "consensus":
      return n;
    case "quorum":
      return Math.min(policy.quorum, n);
    case "majority":
    default:
      return Math.floor(n / 2) + 1;
  }
}

function decideOnTimer(
  base: Omit<Tally, "need" | "decision" | "reason">,
  policy: GatePolicy,
  p: Proposal,
  timedOut: boolean,
  need: number,
  reason: string,
): Tally {
  if (!timedOut) {
    return { ...base, need, decision: "pending", reason };
  }
  // Timer fired. Silence counts as consent only if enough people spoke up.
  if (base.yes >= policy.minYesOnTimeout) {
    // With the veto off, a "no" that did not make the threshold unreachable
    // does not stop the timer — but the resolution must not then claim there
    // were no objections. It is written to the audit log.
    const objections = base.no > 0 ? `${base.no} objection${base.no === 1 ? "" : "s"} overruled` : "no objections";
    return {
      ...base,
      need: 0,
      decision: "approve",
      reason: policy.minYesOnTimeout > 0 ? `timer: ${base.yes} approvals, ${objections}` : `timer: ${objections}`,
    };
  }
  return { ...base, need, decision: "reject", reason: `timer: needed ${policy.minYesOnTimeout} approvals, got ${base.yes}` };
}

/** Whoever wrote the proposal's current text: the last amender, else the author. */
function presumedAuthor(p: Proposal): string {
  return p.edits.at(-1)?.by ?? p.authorId;
}

/**
 * Only a veto that counted may explain the rejection. A "no" left behind by
 * someone who has since disconnected is ignored by the tally, so quoting its
 * comment would blame the rejection on a reason that did not cause it.
 */
function vetoReason(p: Proposal, electorate: Set<string>): string {
  const blockers = Object.entries(p.votes)
    .filter(([id, r]) => r.vote === "no" && electorate.has(id))
    .map(([, r]) => r.comment)
    .filter(Boolean);
  return blockers.length ? `vetoed: ${blockers[0]}` : "vetoed";
}

/** Human-friendly progress line, e.g. `2/3 ✓  1 pending  18s left`. */
export function renderTally(t: Tally, deadline: number | null, now: number): string {
  const bits = [`${t.yes}/${t.electorate} ✓`];
  if (t.no > 0) bits.push(`${t.no} ✗`);
  if (t.pending.length) bits.push(`${t.pending.length} pending`);
  if (deadline !== null && t.decision === "pending") {
    const left = Math.max(0, Math.ceil((deadline - now) / 1000));
    bits.push(`${left}s left`);
  }
  return bits.join(" · ");
}
