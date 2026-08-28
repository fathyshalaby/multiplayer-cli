# Protocol

*The wire format, for writing your own client. Reference material — you do not need this to use a room.*

Everything is newline-free JSON frames over one WebSocket. `src/protocol.ts` is
the authority; this page is the map. Current version: **5** (`PROTOCOL_VERSION`).

A client that speaks this can be a seat — the browser seat in
`src/client/web/session.html` is about 200 lines of it.

## Connecting

```
ws(s)://<host>/r/<room>?t=<token>      # relayed room
ws(s)://<host>:<port>/?t=<token>       # direct room
```

A connection opens with a key agreement, not a message. The client sends an
ephemeral P-256 public key and a nonce, MAC'd with a key derived from the room
token; the host replies in kind, MAC'ing the client's half too. Both derive the
session key from the shared point and both nonces. Every frame after that is
sealed with AES-256-GCM and carries a sequence number inside the ciphertext.

Handshake frames are JSON and begin with `{`; data frames are base64 and never
do. A room started with `--open` has no token, so it skips all of this and
speaks plain JSON.

Then send `hello`. Anything else before it is refused.

```json
{"t":"hello","name":"alice","protocol":1,"observer":false}
```

The room replies with `welcome`, carrying your `Participant` and a full
`RoomSnapshot`. A protocol mismatch closes the socket with code `4004`; a bad
token with `4003`.

## Client → server

| `t` | Meaning |
|---|---|
| `hello` | join |
| `propose` | suggest something for the model; `race: n` asks for n parallel lanes (`0` = the room's default) |
| `vote` | `yes` / `no` / `abstain`, with an optional `comment` |
| `amend` | rewrite a pending proposal; clears its votes |
| `withdraw` | take back your own proposal |
| `chat` | talk to the room; never reaches the model |
| `typing` | presence hint |
| `interrupt` | stop the running turn |
| `setPolicy` | `{preset?, overrides?}` — host only |
| `rename` | change your display name |
| `passMic` | hand over the mic in round-robin mode |
| `setLanes` | how many lanes a bare race opens — host only |
| `ask` | put a fork to the room: a question and two to six options |
| `sync` | ask for a fresh snapshot |
| `ping` | keepalive; answered with `pong` |

Runner messages — only meaningful in a `--pool` room — are `runner`,
`runnerGone`, `runOut`, `runTool`, `runNotice`, `runEnd`.

## Server → client

| `t` | Meaning |
|---|---|
| `welcome` | you, plus the whole room |
| `snapshot` | the whole room again |
| `presence` | the roster changed |
| `proposal` | a proposal was created, voted on, or amended — carries a `Tally` |
| `resolved` | it was approved, rejected, withdrawn or expired |
| `queued` | approved prompts waiting for the model |
| `turnStart` | a turn is being sent, and who contributed to it |
| `delta` | streamed model output (`text` or `thinking`); `lane` set when it came from a race |
| `toolResult` | a tool ran, with a short preview; `lane` as above |
| `turnEnd` | stop reason, usage, error. `stopReason: "lanes"` means a race finished |
| `lanes` | the state of every lane in the current or most recent race |
| `crossroads` | the fork the room is deciding, or `null` when it has settled |
| `agent` | the session's state changed |
| `chat` | side chat |
| `policy` | the rules changed |
| `notice` | something worth saying, at `info`/`warn`/`error` |
| `error` | your last message was refused |
| `runners` | the account roster, in a `--pool` room |
| `runTurn` / `runCancel` | sent only to the seat asked to run a turn |

## The shapes that matter

```ts
interface Proposal {
  id: string;            // "#4" — quotable in chat
  kind: "prompt" | "tool" | "lane" | "choice";
  authorId: string;      // participant id, or "agent" for tool calls and lanes
  authorName: string;
  text: string;
  tool?: ToolRequest;    // when kind === "tool"
  race?: number;         // on a prompt: run it in this many parallel lanes
  lane?: string;         // on a lane proposal: which lane landing would merge
  option?: string;       // on a choice proposal: which direction it ratifies
  createdAt: number;
  deadline: number | null;   // when the timer decides
  votes: Record<string, { vote: Vote; at: number; comment?: string }>;
  edits: { at: number; by: string; byName: string; from: string }[];
  status: "open" | "approved" | "sent" | "rejected" | "withdrawn" | "expired";
  resolution?: string;   // human-readable, e.g. "vetoed: not on prod"
}

interface CrossroadsInfo {
  id: string;
  question: string;
  askedById: string;     // participant id, or "agent"
  askedByName: string;
  options: { id: string; label: string; detail?: string; proposalId: string | null }[];
  createdAt: number;
  chosen: string | null; // the option id, once ratified
  state: "open" | "decided" | "abandoned";
  blocking: boolean;     // a turn is genuinely paused on this answer
}

interface LaneInfo {
  id: string;            // "A" — short enough to say out loud
  turnId: string;
  branch: string;        // mpx/<room>/<turn>/<lane>
  dir: string;           // the lane's checkout, so a seat can go and look
  backend: string;
  state: "running" | "done" | "empty" | "failed" | "landed" | "discarded";
  summary: string;       // "3 files +64 -12"
  detail: string;        // per-file diffstat
  commit: string | null;
  error?: string;
  proposalId: string | null;   // the vote to land it
  startedAt: number;
  endedAt: number | null;
}

interface Tally {
  yes: number; no: number; abstain: number;
  pending: string[];     // who has not voted
  electorate: number;    // connected, non-observer participants
  need: number;          // yes votes still required
  decision: "pending" | "approve" | "reject";
  reason: string;
}
```

## Rules a client should honour

- **Bare text is a proposal, not a message.** That is the whole model.
- **Do not compute the verdict yourself.** The room decides; a client renders
  the `Tally` it is given. `src/core/gate.ts` is pure and takes `now` as an
  argument, so it can be reused verbatim if you want the same arithmetic.
- **A proposal id is stable**, so updates can replace an existing card.
- **`delta` frames are fragments**, not lines. Buffer them.
- **A crossroads is one question, not N proposals.** The options arrive as
  ordinary `choice` proposals so voting works unchanged, but render the
  question above them — the options mean nothing on their own.
- **Keep lane output out of the main transcript.** A `delta` with `lane` set is
  one of several agents writing at once; interleaving them into one stream is
  unreadable. Render lanes as a list and let the diffs do the talking.
- **Send `ping` every ~25s.** Idle sockets get dropped by intermediaries.

## The transcript

The audit log is the same `ServerMessage` values, one per line, wrapped as
`{"at": <ms>, "msg": {...}}`. Streamed text is coalesced to one entry per turn.
`presence` and `pong` are not recorded.

---

[← All documentation](./README.md)
