import { chmodSync, createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ServerMessage } from "../protocol.js";

export interface TranscriptEntry {
  at: number;
  msg: ServerMessage;
}

/**
 * Append-only JSONL record of everything the room saw.
 *
 * A shared session needs an audit trail more than a solo one does: who
 * proposed a change, who approved it, who vetoed, and what the model then did
 * with it. Text deltas are coalesced per turn so the file stays readable.
 */
export class Transcript {
  private stream: WriteStream | null = null;
  private pending = new Map<string, string>();

  constructor(readonly path: string | null) {
    if (!path) return;
    // 0700/0600, not whatever the umask says.
    //
    // This file is the room in plain text — every proposal, every veto reason,
    // the chat, and everything the model said, which includes whatever it read
    // out of the repository. The default 0644 makes all of that readable by
    // every account on the machine, which on a dev box, a build agent or a
    // shared jump host is a real audience. The wire is encrypted with some
    // care; it would be odd to then leave the transcript of it world-readable.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.stream = createWriteStream(path, { flags: "a", mode: 0o600 });
    // `mode` only applies when the file is created, and a resumed room appends
    // to one that already exists. Tighten it either way; best-effort, because
    // not every filesystem has anything to tighten.
    try {
      chmodSync(path, 0o600);
    } catch {
      /* windows, a mounted share, someone else's file — leave it be */
    }
  }

  write(msg: ServerMessage): void {
    if (!this.stream) return;
    // Buffer streaming text: one line per turn beats one line per token.
    if (msg.t === "delta") {
      if (msg.kind !== "text") return;
      this.pending.set(msg.turnId, (this.pending.get(msg.turnId) ?? "") + msg.text);
      return;
    }
    if (msg.t === "turnEnd") {
      const text = this.pending.get(msg.turnId);
      this.pending.delete(msg.turnId);
      if (text) {
        this.append({ t: "delta", turnId: msg.turnId, kind: "text", text });
      }
    }
    if (msg.t === "pong" || msg.t === "presence") return;
    this.append(msg);
  }

  private append(msg: ServerMessage): void {
    this.stream?.write(JSON.stringify({ at: Date.now(), msg } satisfies TranscriptEntry) + "\n");
  }

  async close(): Promise<void> {
    const s = this.stream;
    this.stream = null;
    if (!s) return;
    await new Promise<void>((r) => s.end(r));
  }
}

export async function readTranscript(path: string): Promise<TranscriptEntry[]> {
  const raw = await readFile(path, "utf8");
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v.at === "number" && v.msg) out.push(v as TranscriptEntry);
    } catch {
      /* skip a torn final line from an interrupted session */
    }
  }
  return out;
}
