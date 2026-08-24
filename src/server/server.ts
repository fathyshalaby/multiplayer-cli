import { timingSafeEqual } from "node:crypto";
import type { ClientMessage, Proposal, RoomPolicy, ServerMessage, ToolRequest } from "../protocol.js";
import { PROTOCOL_VERSION, decode, encode } from "../protocol.js";
import { Room } from "../core/room.js";
import { Transcript } from "../core/transcript.js";
import { applyOverrides, resolvePreset } from "../core/policy.js";
import { createBackend, multiplayerSystemPrompt, type BackendName } from "../agent/index.js";
import type { AgentBackend, TurnResult } from "../agent/types.js";
import { id } from "../util/id.js";
import type { Peer, Transport, TransportInfo } from "./transport.js";

export interface ServerOptions {
  /** How seats reach this room: a local port, or a relay the host dials out to. */
  transport: Transport;
  roomName: string;
  token: string | null;
  policy: RoomPolicy;
  cwd: string;
  backend: BackendName;
  model: string;
  maxTokens: number;
  showThinking: boolean;
  systemPromptExtra: string;
  /** Override the binary a CLI backend launches. */
  backendBin: string;
  /** Verbatim extra arguments appended to a CLI backend's command line. */
  backendArgs: string[];
  permissionMode: string;
  /** Session/thread id to continue, in whatever form that backend uses. */
  resume: string | null;
  /** URL of an already-running agent server to attach to (OpenCode). */
  attach: string | null;
  transcriptPath: string | null;
  /** Injected in tests to avoid touching a real model. */
  backendFactory?: (opts: { participants: string[] }) => AgentBackend;
}

/**
 * Hosts one room: a WebSocket endpoint, the room state machine, and the single
 * AI session they share. All model traffic originates here, so no participant
 * needs an API key — only the host does.
 */
export class RoomServer {
  readonly room: Room;
  private transport: Transport;
  private info: TransportInfo | null = null;
  private peers = new Map<string, Peer>();
  private transcript: Transcript;
  private backend: AgentBackend | null = null;
  private opts: ServerOptions;
  private running = false;
  private abort: AbortController | null = null;
  private pendingTools = new Map<string, (d: { allow: boolean; reason: string }) => void>();
  private closed = false;

  constructor(opts: ServerOptions) {
    this.opts = opts;
    this.transcript = new Transcript(opts.transcriptPath);
    this.room = new Room({
      name: opts.roomName,
      cwd: opts.cwd,
      policy: opts.policy,
      transcriptPath: opts.transcriptPath,
    });

    this.room.on("broadcast", (msg: ServerMessage) => {
      this.transcript.write(msg);
      this.broadcast(msg);
    });
    this.room.on("promptReady", () => void this.pump());
    this.room.on("toolDecision", (p: Proposal, allow: boolean, reason: string) => {
      const key = p.tool?.toolUseId;
      if (!key) return;
      const resolver = this.pendingTools.get(key);
      if (!resolver) return;
      this.pendingTools.delete(key);
      resolver({ allow, reason });
    });

    this.transport = opts.transport;
    this.transport.onPeer((peer) => this.onPeer(peer));
  }

  async listen(): Promise<TransportInfo> {
    this.info = await this.transport.start();
    this.running = true;
    return this.info;
  }

  /** The command teammates run, whichever transport is in play. */
  joinUrl(): string {
    return this.info?.joinUrl(this.opts.token) ?? "";
  }

  inviteDetail(): string[] {
    return this.info?.detail(this.opts.token) ?? [];
  }

  private authorized(peer: Peer): boolean {
    if (!this.opts.token) return true;
    const supplied = peer.query.get("t") ?? "";
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.opts.token);
    // Compare in constant time, and only when the lengths already match so
    // timingSafeEqual does not throw on a short guess. This runs at the host
    // even when a relay carried the connection here — the relay never sees it.
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private onPeer(ws: Peer): void {
    if (!this.authorized(ws)) {
      ws.send(encode({ t: "error", text: "bad or missing room token" }));
      ws.close(4003, "unauthorized");
      return;
    }

    const connectionId = ws.id;
    let joined = false;

    ws.onMessage((raw) => {
      const msg = decode<ClientMessage>(raw);
      if (!msg) {
        ws.send(encode({ t: "error", text: "malformed message" }));
        return;
      }
      if (!joined) {
        if (msg.t !== "hello") {
          ws.send(encode({ t: "error", text: "say hello first" }));
          return;
        }
        if (msg.protocol !== PROTOCOL_VERSION) {
          ws.send(
            encode({
              t: "error",
              text: `protocol mismatch: room speaks v${PROTOCOL_VERSION}, you speak v${msg.protocol}. Update multiplayer-cli.`,
            }),
          );
          ws.close(4004, "protocol");
          return;
        }
        joined = true;
        const isFirst = this.room.list().length === 0;
        // Join first, register the socket after: the newcomer gets a welcome
        // with the room already in it, rather than a notice of their own arrival.
        const p = this.room.join({
          name: msg.name,
          role: msg.observer ? "observer" : isFirst ? "owner" : "member",
          connectionId,
        });
        this.peers.set(connectionId, ws);
        ws.send(
          encode({
            t: "welcome",
            you: p,
            room: this.room.snapshot(),
            motd: this.motd(),
          }),
        );
        return;
      }
      this.handle(connectionId, msg, ws);
    });

    ws.onClose(() => {
      if (!joined) return;
      joined = false;
      this.peers.delete(connectionId);
      this.room.leave(connectionId);
    });
  }

  private motd(): string {
    return `${this.room.name} · ${this.opts.backend}${this.opts.model ? `/${this.opts.model}` : ""} · ${this.opts.cwd}`;
  }

  private handle(pid: string, msg: ClientMessage, ws: Peer): void {
    const fail = (text: string) => ws.send(encode({ t: "error", text }));

    switch (msg.t) {
      case "propose": {
        const result = this.room.propose(pid, msg.text);
        if ("error" in result) fail(result.error);
        return;
      }
      case "vote":
        return void err(fail, this.room.vote(pid, msg.proposalId, msg.vote, msg.comment));
      case "amend":
        return void err(fail, this.room.amend(pid, msg.proposalId, msg.text));
      case "withdraw":
        return void err(fail, this.room.withdraw(pid, msg.proposalId));
      case "rename":
        this.room.rename(pid, msg.name);
        return;
      case "typing":
        this.room.setTyping(pid, msg.typing);
        return;
      case "passMic":
        return void err(fail, this.room.passMic(pid, msg.toId));
      case "chat": {
        const p = this.room.get(pid);
        if (!p) return;
        const out: ServerMessage = {
          t: "chat",
          fromId: pid,
          fromName: p.name,
          text: msg.text,
          at: Date.now(),
        };
        this.transcript.write(out);
        this.broadcast(out);
        return;
      }
      case "interrupt": {
        if (!this.room.canInterrupt(pid)) return fail("the room policy does not let you interrupt");
        const p = this.room.get(pid);
        if (!this.abort) return fail("nothing is running");
        this.room.notice("warn", `${p?.name ?? "someone"} interrupted the turn`);
        this.abort.abort();
        // Deny anything the room was still voting on; the turn is over.
        for (const [key, resolve] of this.pendingTools) {
          this.pendingTools.delete(key);
          resolve({ allow: false, reason: "turn interrupted" });
        }
        return;
      }
      case "setPolicy": {
        const next = this.parsePolicyPatch(msg.patch);
        if ("error" in next) return fail(next.error);
        return void err(fail, this.room.setPolicy(pid, next.policy));
      }
      case "sync":
        ws.send(encode({ t: "snapshot", room: this.room.snapshot() }));
        return;
      case "ping":
        ws.send(encode({ t: "pong" }));
        return;
      default:
        fail(`unsupported message ${(msg as { t: string }).t}`);
    }
  }

  private parsePolicyPatch(patch: unknown): { policy: RoomPolicy } | { error: string } {
    if (!patch || typeof patch !== "object") return { error: "bad policy patch" };
    const { preset, overrides } = patch as { preset?: string; overrides?: string[] };
    let base = this.room.policy;
    if (preset) {
      const p = resolvePreset(preset);
      if (!p) return { error: `unknown preset "${preset}"` };
      base = p;
    }
    if (overrides?.length) {
      const { policy, errors } = applyOverrides(base, overrides);
      if (errors.length) return { error: errors.join("; ") };
      return { policy };
    }
    return { policy: base };
  }

  /* ---------------------------------------------------------------- */
  /* the shared AI session                                             */
  /* ---------------------------------------------------------------- */

  private ensureBackend(): AgentBackend {
    if (this.backend) return this.backend;
    const participants = this.room.list().map((p) => p.name);
    if (this.opts.backendFactory) {
      this.backend = this.opts.backendFactory({ participants });
    } else {
      this.backend = createBackend({
        backend: this.opts.backend,
        cwd: this.opts.cwd,
        model: this.opts.model,
        maxTokens: this.opts.maxTokens,
        showThinking: this.opts.showThinking,
        systemPrompt: multiplayerSystemPrompt(this.opts.systemPromptExtra, participants, this.opts.cwd),
        backendBin: this.opts.backendBin,
        backendArgs: this.opts.backendArgs,
        permissionMode: this.opts.permissionMode,
        resume: this.opts.resume,
        attach: this.opts.attach,
      });
    }
    this.room.setAgent({ backend: this.backend.name, model: this.backend.model });
    return this.backend;
  }

  /** Drain the approved queue, one turn at a time. */
  private async pump(): Promise<void> {
    if (this.closed) return;
    if (this.room.agent.state !== "idle" && this.room.agent.state !== "error") return;
    const batch = this.room.takeQueued();
    if (!batch.length) return;

    const backend = this.ensureBackend();
    const turnId = id("turn", 6);
    const prompt = this.room.composeTurn(batch);
    const contributors = [...new Set(batch.map((p) => p.authorName))];
    this.room.lastTurnAuthors = new Set(batch.map((p) => p.authorId));
    this.room.turnCount += 1;

    const start: ServerMessage = { t: "turnStart", turnId, prompt, contributors };
    this.transcript.write(start);
    this.broadcast(start);
    this.room.setAgent({ state: "thinking", turnId, detail: "" });

    this.abort = new AbortController();
    let sawText = false;

    const result = await backend
      .send(
        prompt,
        {
          onText: (text) => {
            if (!text) return;
            if (!sawText) {
              sawText = true;
              this.room.setAgent({ state: "streaming", turnId });
            }
            this.fanout({ t: "delta", turnId, kind: "text", text });
          },
          onThinking: (text) => {
            if (text) this.fanout({ t: "delta", turnId, kind: "thinking", text });
          },
          onToolRequest: (req) => this.voteOnTool(turnId, req),
          onToolResult: (toolUseId, ok, preview) => {
            this.fanout({ t: "toolResult", turnId, toolUseId, ok, preview });
          },
          onNotice: (text) => this.room.notice("info", text),
        },
        this.abort.signal,
      )
      .catch((err): TurnResult => ({
        stopReason: "error",
        error: (err as Error)?.message ?? String(err),
      }));

    this.abort = null;
    const end: ServerMessage = {
      t: "turnEnd",
      turnId,
      stopReason: result.stopReason,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    this.transcript.write(end);
    this.broadcast(end);
    this.room.setAgent({
      state: result.error ? "error" : "idle",
      turnId: null,
      ...(result.error ? { detail: result.error } : { detail: "" }),
    });

    // Anything approved while this turn ran goes next.
    if (this.room.queuedIds().length) void this.pump();
  }

  /**
   * Put a tool call to the room, unless its risk class is auto-allowed.
   * Blocks the turn until the vote resolves — which is the point.
   */
  private voteOnTool(turnId: string, req: ToolRequest): Promise<{ allow: boolean; reason: string }> {
    if (this.room.policy.autoAllowToolRisks.includes(req.risk)) {
      return Promise.resolve({ allow: true, reason: `auto-allowed (${req.risk})` });
    }
    this.room.setAgent({ state: "tool", turnId, detail: req.summary });
    return new Promise((resolve) => {
      this.pendingTools.set(req.toolUseId, (d) => {
        this.room.setAgent({ state: "streaming", turnId, detail: "" });
        resolve(d);
      });
      this.room.proposeTool(req);
    });
  }

  private fanout(msg: ServerMessage): void {
    this.transcript.write(msg);
    this.broadcast(msg);
  }

  private broadcast(msg: ServerMessage): void {
    const frame = encode(msg);
    for (const peer of this.peers.values()) peer.send(frame);
  }

  get isRunning(): boolean {
    return this.running;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    for (const [key, resolve] of this.pendingTools) {
      this.pendingTools.delete(key);
      resolve({ allow: false, reason: "room closing" });
    }
    this.room.close();
    for (const peer of this.peers.values()) peer.close(1001, "room closed");
    this.peers.clear();
    await this.transport.close();
    await this.backend?.close();
    await this.transcript.close();
  }
}

function err(fail: (t: string) => void, e: string | null): void {
  if (e) fail(e);
}
