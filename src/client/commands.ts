import type { ClientMessage } from "../protocol.js";

export interface CommandContext {
  /** Newest open proposal id, used when a vote omits the handle. */
  defaultProposal: () => string;
}

export type CommandResult =
  | { kind: "send"; msg: ClientMessage }
  | { kind: "local"; action: LocalAction; arg?: string }
  | { kind: "error"; text: string }
  | { kind: "noop" };

export type LocalAction = "help" | "quit" | "who" | "queue" | "status" | "clear" | "transcript" | "policy" | "lanes" | "fork";

interface Spec {
  names: string[];
  args: string;
  help: string;
  run: (rest: string, ctx: CommandContext) => CommandResult;
}

const SPECS: Spec[] = [
  {
    names: ["y", "yes", "ok", "approve", "+1"],
    args: "[#id]",
    help: "approve a proposal (defaults to the newest open one)",
    run: (rest, ctx) => ({
      kind: "send",
      msg: { t: "vote", proposalId: handle(rest, ctx), vote: "yes" },
    }),
  },
  {
    names: ["n", "no", "veto", "-1"],
    args: "[#id] [reason]",
    help: "reject a proposal; with veto enabled this alone stops it",
    run: (rest, ctx) => {
      const { id, tail } = splitHandle(rest, ctx);
      return {
        kind: "send",
        msg: { t: "vote", proposalId: id, vote: "no", ...(tail ? { comment: tail } : {}) },
      };
    },
  },
  {
    names: ["abstain", "pass"],
    args: "[#id]",
    help: "record no opinion, so the room stops waiting on you",
    run: (rest, ctx) => ({
      kind: "send",
      msg: { t: "vote", proposalId: handle(rest, ctx), vote: "abstain" },
    }),
  },
  {
    names: ["amend", "edit"],
    args: "[#id] <new text>",
    help: "rewrite a pending proposal; existing votes are cleared",
    run: (rest, ctx) => {
      const { id, tail } = splitHandle(rest, ctx);
      if (!tail) return { kind: "error", text: "usage: /amend [#id] <new text>" };
      return { kind: "send", msg: { t: "amend", proposalId: id, text: tail } };
    },
  },
  {
    names: ["withdraw", "cancel"],
    args: "[#id]",
    help: "take back a proposal you made",
    run: (rest, ctx) => ({ kind: "send", msg: { t: "withdraw", proposalId: handle(rest, ctx) } }),
  },
  {
    names: ["ask"],
    args: "<question> | <option> | <option>",
    help: "put a fork to the room and let it pick the direction",
    run: (rest) => {
      const parts = rest.split("|").map((s) => s.trim()).filter(Boolean);
      const [question, ...options] = parts;
      if (!question || options.length < 2) {
        return { kind: "error", text: "usage: /ask <question> | <option> | <option>" };
      }
      return { kind: "send", msg: { t: "ask", question, options } };
    },
  },
  {
    names: ["fork"],
    args: "",
    help: "show the fork the room is deciding, if there is one",
    run: () => ({ kind: "local", action: "fork" }),
  },
  {
    names: ["race"],
    args: "[n] <prompt>",
    help: "try one prompt in n parallel worktrees, then vote on which result lands",
    run: (rest) => {
      const trimmed = rest.trim();
      // `/race 4 add retries` sets the width; `/race add retries` uses the
      // room's default. A leading number is only a count when there is a
      // prompt after it, so "/race 3" is a mistake worth naming.
      const m = /^(\d+)(\s+|$)/.exec(trimmed);
      const count = m ? Number(m[1]) : 0; // 0 asks the room for its default
      const text = m ? trimmed.slice(m[0].length).trim() : trimmed;
      if (!text) return { kind: "error", text: "usage: /race [n] <prompt>" };
      return { kind: "send", msg: { t: "propose", text, race: count } };
    },
  },
  {
    names: ["lanes"],
    args: "[n]",
    help: "show the current lanes, or set how many a bare /race opens (host)",
    run: (rest) => {
      const trimmed = rest.trim();
      if (!trimmed) return { kind: "local", action: "lanes" };
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n < 0) return { kind: "error", text: "usage: /lanes [n]" };
      return { kind: "send", msg: { t: "setLanes", count: n } };
    },
  },
  {
    names: ["say", "chat", "s"],
    args: "<text>",
    help: "talk to the room without involving the model",
    run: (rest) =>
      rest.trim()
        ? { kind: "send", msg: { t: "chat", text: rest.trim() } }
        : { kind: "error", text: "usage: /say <text>" },
  },
  {
    names: ["stop", "interrupt", "esc"],
    args: "",
    help: "interrupt the running turn",
    run: () => ({ kind: "send", msg: { t: "interrupt" } }),
  },
  {
    names: ["me", "nick", "name"],
    args: "<name>",
    help: "change your display name",
    run: (rest) =>
      rest.trim()
        ? { kind: "send", msg: { t: "rename", name: rest.trim() } }
        : { kind: "error", text: "usage: /me <name>" },
  },
  {
    names: ["mic"],
    args: "<name>",
    help: "hand the mic to someone (round-robin mode)",
    run: (rest) =>
      rest.trim()
        ? { kind: "send", msg: { t: "passMic", toId: rest.trim() } }
        : { kind: "error", text: "usage: /mic <name>" },
  },
  {
    names: ["policy"],
    args: "[preset] [key=value ...]",
    help: "show or change the room's decision rules (host only)",
    run: (rest) => {
      const parts = rest.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return { kind: "local", action: "policy" };
      const preset = parts[0]!.includes("=") ? undefined : parts[0];
      const overrides = parts.filter((p) => p.includes("="));
      return { kind: "send", msg: { t: "setPolicy", patch: { preset, overrides } } };
    },
  },
  { names: ["who", "w", "room"], args: "", help: "list who is in the room", run: () => ({ kind: "local", action: "who" }) },
  { names: ["queue", "q", "open"], args: "", help: "list proposals awaiting a decision", run: () => ({ kind: "local", action: "queue" }) },
  { names: ["status", "st"], args: "", help: "show the session's current state", run: () => ({ kind: "local", action: "status" }) },
  { names: ["transcript", "log"], args: "", help: "print the transcript path", run: () => ({ kind: "local", action: "transcript" }) },
  { names: ["clear", "cls"], args: "", help: "clear the screen", run: () => ({ kind: "local", action: "clear" }) },
  { names: ["help", "h", "?"], args: "", help: "show this list", run: () => ({ kind: "local", action: "help" }) },
  { names: ["quit", "exit", "q!"], args: "", help: "leave the room", run: () => ({ kind: "local", action: "quit" }) },
];

/**
 * Turn a line of input into an action.
 *
 * Bare text is a *proposal*, not a message — in a gated room, typing is
 * suggesting. Everything else is a slash command.
 */
export function parse(line: string, ctx: CommandContext): CommandResult {
  const text = line.trim();
  if (!text) return { kind: "noop" };
  if (!text.startsWith("/")) return { kind: "send", msg: { t: "propose", text } };

  const sp = text.indexOf(" ");
  const name = (sp < 0 ? text.slice(1) : text.slice(1, sp)).toLowerCase();
  const rest = sp < 0 ? "" : text.slice(sp + 1);

  const spec = SPECS.find((s) => s.names.includes(name));
  if (!spec) return { kind: "error", text: `unknown command /${name} — try /help` };
  return spec.run(rest, ctx);
}

function handle(rest: string, ctx: CommandContext): string {
  return splitHandle(rest, ctx).id;
}

/** Pull a leading `#3` or `3` off the argument, if present. */
function splitHandle(rest: string, ctx: CommandContext): { id: string; tail: string } {
  const trimmed = rest.trim();
  const m = /^(#?\d+)\s*(.*)$/s.exec(trimmed);
  if (m) return { id: m[1]!.startsWith("#") ? m[1]! : `#${m[1]}`, tail: m[2]!.trim() };
  return { id: ctx.defaultProposal(), tail: trimmed };
}

export function helpLines(): string[] {
  const out: string[] = [];
  for (const s of SPECS) {
    const label = `/${s.names[0]}${s.args ? " " + s.args : ""}`;
    const aliases = s.names.length > 1 ? `  (${s.names.slice(1).map((n) => "/" + n).join(", ")})` : "";
    out.push(`${label.padEnd(28)} ${s.help}${aliases}`);
  }
  out.push("");
  out.push("Anything that is not a command becomes a proposal the room votes on.");
  return out;
}

export function commandNames(): string[] {
  return SPECS.flatMap((s) => s.names).map((n) => "/" + n);
}
