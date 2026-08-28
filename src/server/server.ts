import { hostname } from "node:os";
import type { ClientMessage, LaneInfo, Proposal, RoomPolicy, ServerMessage, ToolRequest, ToolRisk } from "../protocol.js";
import { CrossroadsStream, type ParsedCrossroads } from "../core/crossroads.js";
import { PROTOCOL_VERSION, decode, encode } from "../protocol.js";
import { MAX_LANES, Room } from "../core/room.js";
import { Transcript } from "../core/transcript.js";
import { applyOverrides, resolvePreset } from "../core/policy.js";
import { carriesSession, createBackend, multiplayerSystemPrompt, GATES_TOOLS, type BackendName } from "../agent/index.js";
import type { AgentBackend, TurnResult } from "../agent/types.js";
import { id } from "../util/id.js";
import type { Peer, Transport, TransportInfo } from "./transport.js";
import { deriveAuthKey } from "../core/crypto.js";
import { SecureChannel } from "../core/secure.js";
import { RoutedBackend } from "./runners.js";
import { LANE_IDS, Race } from "./lanes.js";
import { describeOverlaps, findOverlaps } from "../core/overlap.js";
import { DEFAULT_BASE_PORT, DEFAULT_HOST, DEFAULT_READY_MS } from "../core/preview.js";
import { inspectRepo, type RepoInfo } from "../core/worktree.js";

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
  /**
   * Experimental. Let seats offer their own machine and subscription, so the
   * room can carry on when one account runs out of capacity. Off by default:
   * the plain thing — every turn on the host's account — is what most rooms
   * want, and it has one fewer moving part.
   */
  pool: boolean;
  /**
   * How many parallel attempts a bare `/race` opens. 0 turns racing off; the
   * default is set from whether the room is even in a git repository.
   */
  lanes: number;
  /** Shell command run in each lane's fresh checkout, e.g. `npm ci`. */
  laneSetup: string | null;
  /**
   * Shell command that starts a finished lane, e.g. `npm run dev -- --port {port}`.
   *
   * Null by default. Most work has nothing to look at, and a room that starts
   * one dev server per lane whether or not anyone wanted one is a room that
   * runs out of memory.
   */
  lanePreview?: string | null;
  /** Where preview port hunting starts. Each lane takes the next free one. */
  lanePreviewPort?: number;
  /**
   * The hostname the room is shown in a preview URL.
   *
   * Localhost by default, which is right when the seats are on the host's
   * machine. A host whose teammates can reach it over the network sets this to
   * the name they reach it by; binding the server that wide is the preview
   * command's business, not ours.
   */
  lanePreviewHost?: string;
  /** Where lane checkouts go. Tests point this at a scratch directory. */
  laneDir?: string;
  /** How long a socket has to prove it belongs. Shortened in tests. */
  handshakeMs?: number;
  transcriptPath: string | null;
  /** Injected in tests to avoid touching a real model. */
  backendFactory?: (opts: { participants: string[]; cwd: string; lane?: string }) => AgentBackend;
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
  /**
   * Every accepted socket, joined or not.
   *
   * `peers` holds seats, and a socket only becomes one by saying hello. A
   * connection that never gets that far — still handshaking, or refusing to
   * speak at all — is not in there, so shutting the room down used to leave it
   * attached and the process alive with it.
   */
  private sockets = new Set<Peer>();
  private transcript: Transcript;
  private backend: AgentBackend | null = null;
  private routed: RoutedBackend | null = null;
  private opts: ServerOptions;
  private running = false;
  private abort: AbortController | null = null;
  private pendingTools = new Map<string, (d: { allow: boolean; reason: string }) => void>();
  private closed = false;
  /** The repository lanes branch from, or null when there is not one. */
  private repo: RepoInfo | null = null;
  /** The race whose lanes the room is currently voting on, if any. */
  private race: Race | null = null;
  /**
   * Whether the current set of lanes are complements rather than substitutes.
   *
   * A race's lanes are three tries at one thing, so approving one withdraws the
   * rest. A split's are different work meant to land together, so approving one
   * says nothing about the others and the race ends only when every lane has
   * been decided.
   */
  private splitting = false;
  /**
   * Serialises merges without making them exclusive.
   *
   * A race lands at most once, so a flag was enough. A split can land every
   * lane, and two `git merge` calls at once in the same checkout would tread on
   * each other — so landings queue behind one another instead of racing.
   */
  private landChain: Promise<void> = Promise.resolve();
  /** Resolves the turn a blocking crossroads is holding, once the room picks. */
  private pendingChoice: ((label: string | null) => void) | null = null;
  /**
   * Set the instant a landing starts, not when it finishes.
   *
   * Two lanes can be approved from two separate votes before the first merge's
   * git call has returned, and the lane states alone would not have caught up
   * yet. A flag set synchronously is what actually makes landing exclusive.
   */
  private landing = false;

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
    this.room.on("laneDecision", (p: Proposal, allow: boolean, reason: string) => {
      void this.onLaneDecision(p, allow, reason);
    });
    this.room.on("choiceDecision", (p: Proposal, allow: boolean, reason: string) => {
      this.onChoiceDecision(p, allow, reason);
    });
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
    await this.detectRepo();
    this.info = await this.transport.start();
    this.running = true;
    return this.info;
  }

  /**
   * Lanes are git branches, so a room that is not in a repository simply does
   * not have them. Working that out once at startup means `/race` can say why
   * rather than failing at the moment someone tries to use it.
   */
  private async detectRepo(): Promise<void> {
    if (this.opts.lanes === 0) return;
    const found = await inspectRepo(this.opts.cwd);
    if (!found.ok) {
      this.laneReason = found.error;
      return;
    }
    this.repo = found.value;
    this.room.laneCount = this.opts.lanes;
    if (found.value.dirty) {
      this.laneWarning =
        "the checkout has uncommitted changes — lanes branch from the last commit and will not see them";
    }
  }

  /** Why this room cannot race at all. Null when it can. */
  laneReason: string | null = null;
  /** A caveat that does not stop a race, but that the room should hear first. */
  laneWarning: string | null = null;

  /** Whether this room can race at all. */
  get canRace(): boolean {
    return this.repo !== null && this.room.laneCount > 0;
  }

  /** The command teammates run, whichever transport is in play. */
  joinUrl(): string {
    return this.info?.joinUrl(this.opts.token) ?? "";
  }

  /** Where the host's own seat should connect. */
  selfUrl(): string {
    return this.info?.selfUrl(this.opts.token) ?? "";
  }

  /** The clickable link for chat, when the room is reachable by browser. */
  shareUrl(): string | null {
    return this.info?.shareUrl(this.opts.token) ?? null;
  }

  inviteDetail(): string[] {
    return this.info?.detail(this.opts.token) ?? [];
  }

  /**
   * Authentication is decryption.
   *
   * There is no token on the wire to check: a seat proves it belongs by
   * producing a frame this room's key can open. A wrong token, a tampered
   * frame and a replayed one all fail identically, and all mean the same
   * thing — this did not come from the room.
   */
  private onPeer(ws: Peer): void {
    const channel = new SecureChannel(
      this.opts.token ? deriveAuthKey(this.opts.token, this.opts.roomName) : null,
      this.opts.roomName,
      "server",
    );
    const connectionId = ws.id;
    let joined = false;
    let proven = !channel.encrypted;
    this.sockets.add(ws);

    // Authentication is "produce a frame that decrypts", so a peer that
    // connects and says nothing would otherwise sit here forever. Give it a
    // short window to prove itself, then drop it — a socket that has not
    // spoken cannot be a seat, and holding one open is free for an attacker.
    const handshake = setTimeout(() => {
      if (!proven) ws.close(4008, "handshake timeout");
    }, this.opts.handshakeMs ?? HANDSHAKE_MS);
    handshake.unref?.();

    const send = (msg: ServerMessage) => ws.send(channel.wrap(encode(msg)));
    const secure: Peer = {
      id: ws.id,
      query: ws.query,
      send: (frame) => ws.send(channel.wrap(frame)),
      close: (code, reason) => ws.close(code, reason),
      onMessage: () => {},
      onClose: (cb) => ws.onClose(cb),
    };

    ws.onMessage((frame) => {
      // A connection opens with an ephemeral key agreement, authenticated by
      // the room token. Only once that lands does anything else make sense.
      if (channel.encrypted && !channel.ready) {
        if (!SecureChannel.isHandshake(frame)) {
          ws.close(4003, "unauthorized");
          return;
        }
        const step = channel.handshake(frame);
        if (!step.ok) {
          ws.close(4003, "unauthorized");
          return;
        }
        if (step.reply) ws.send(step.reply);
        // Deliberately not proven yet. Completing the key agreement shows only
        // that someone knew the token when this frame was *first* composed —
        // the client's half is a fixed MAC over its own public key and nonce,
        // with nothing in it that this connection chose. So a captured opening
        // frame replays perfectly, and the replayer holds a socket open
        // forever if finishing the handshake were enough to stop the clock.
        // Only a frame that opens under the agreed key proves the peer holds
        // the private half, and a real client sends `hello` immediately.
        return;
      }

      const raw = channel.unwrap(frame);
      if (raw === null) {
        // Say as little as possible: an attacker learns only that it failed.
        clearTimeout(handshake);
        ws.close(4003, "unauthorized");
        return;
      }
      if (!proven) {
        proven = true;
        clearTimeout(handshake);
      }
      const msg = decode<ClientMessage>(raw);
      if (!msg) {
        send({ t: "error", text: "malformed message" });
        return;
      }
      if (!joined) {
        if (msg.t !== "hello") {
          send({ t: "error", text: "say hello first" });
          return;
        }
        if (msg.protocol !== PROTOCOL_VERSION) {
          send({
            t: "error",
            text: `protocol mismatch: room speaks v${PROTOCOL_VERSION}, you speak v${msg.protocol}. Update multiplayer-cli.`,
          });
          ws.close(4004, "protocol");
          return;
        }
        joined = true;
        // Join first, register the socket after: the newcomer gets a welcome
        // with the room already in it, rather than a notice of their own arrival.
        // Whether this one ends up hosting is the room's call, not ours — it
        // knows whether anybody is already doing it.
        const p = this.room.join({
          name: msg.name,
          role: msg.observer ? "observer" : "member",
          connectionId,
        });
        this.peers.set(connectionId, secure);
        send({ t: "welcome", you: p, room: this.room.snapshot(), motd: this.motd() });
        return;
      }
      this.handle(connectionId, msg, secure);
    });

    ws.onClose(() => {
      clearTimeout(handshake);
      this.sockets.delete(ws);
      if (!joined) return;
      joined = false;
      this.peers.delete(connectionId);
      this.routed?.remove(connectionId);
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
        // `race: 0` is "however many lanes this room uses", resolved here so
        // the seat does not have to track the room's default itself.
        const race = msg.race === undefined ? undefined : msg.race || this.room.laneCount;
        const parallel = race !== undefined || msg.split !== undefined;
        if (parallel && !this.canRace) {
          return fail(this.laneReason ?? "this room cannot use lanes — it is not hosted in a git repository");
        }
        const result = this.room.propose(pid, msg.text, race, msg.split);
        if ("error" in result) fail(result.error);
        else if (parallel && this.laneWarning) this.room.notice("warn", this.laneWarning);
        return;
      }
      case "ask": {
        const p = this.room.get(pid);
        if (!p) return;
        if (p.role === "observer") return fail("observers cannot put a fork to the room");
        const result = this.room.ask(
          pid,
          p.name,
          msg.question,
          msg.options.map((label) => ({ label })),
          false,
        );
        if ("error" in result) fail(result.error);
        return;
      }
      case "setLanes": {
        const p = this.room.get(pid);
        if (!p) return;
        if (p.role !== "owner") return fail("only the host can change the lane count");
        if (!this.repo) return fail(this.laneReason ?? "this room is not hosted in a git repository");
        if (!Number.isInteger(msg.count) || msg.count < 0 || msg.count > MAX_LANES) {
          return fail(`lanes must be between 0 and ${MAX_LANES}`);
        }
        this.room.laneCount = msg.count;
        this.room.notice("info", msg.count ? `/race opens ${msg.count} lanes` : "racing is off");
        this.publishLanes();
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
        if (this.pendingChoice) {
          this.pendingChoice(null);
          this.pendingChoice = null;
          this.room.abandonCrossroads("turn interrupted");
        }
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
      case "runner": {
        const p = this.room.get(pid);
        if (!p) return;
        if (!this.opts.pool) {
          return fail("this room runs every turn on the host's account — the host can pool accounts with --pool");
        }
        if (p.role === "observer") return fail("observers cannot run turns");
        this.ensureRouted().add(pid, p.name, msg.backend, msg.cwd);
        return;
      }
      case "runnerGone":
        this.routed?.remove(pid);
        return;
      case "runOut":
        this.routed?.onOut(pid, msg.turnId, msg.kind, msg.text);
        return;
      case "runTool":
        this.routed?.onTool(pid, msg.turnId, msg.toolUseId, msg.ok, msg.preview);
        return;
      case "runNotice":
        this.routed?.onRunnerNotice(pid, msg.turnId, msg.text);
        return;
      case "runEnd":
        this.routed?.onEnd(pid, msg.turnId, {
          stopReason: msg.stopReason,
          ...(msg.usage ? { usage: msg.usage } : {}),
          ...(msg.error ? { error: msg.error } : {}),
          ...(msg.limited ? { limited: true } : {}),
          ...(msg.until !== undefined ? { until: msg.until } : {}),
        });
        return;
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

  /**
   * The room's backend is always the router; the host's own CLI is simply its
   * first runner. That way a turn can move to someone else's subscription
   * without the room's turn logic knowing anything changed.
   */
  private ensureRouted(): RoutedBackend {
    if (this.routed) return this.routed;
    const local = this.ensureBackend();
    const routed = new RoutedBackend({
      dispatch: {
        start: (runnerId, turnId, prompt) => this.toPeer(runnerId, { t: "runTurn", turnId, prompt }),
        cancel: (runnerId, turnId) => this.toPeer(runnerId, { t: "runCancel", turnId }),
      },
      onChange: () => this.publishRunners(),
      onNotice: (text) => this.room.notice("warn", text),
      gatesTools: (backend) => GATES_TOOLS.includes(backend as BackendName),
      // Only worth saying when the room would actually have voted: a policy
      // that auto-allows every risk level was never going to stop anything,
      // so pointing at a weakened gate would be noise.
      toolsAreGated: () => {
        const p = this.room.policy;
        const risks: ToolRisk[] = ["read", "write", "exec"];
        return p.tool.mode !== "open" && risks.some((r) => !p.autoAllowToolRisks.includes(r));
      },
    });
    routed.addLocal(this.hostName(), local, this.opts.cwd);
    this.routed = routed;
    this.publishRunners();
    return routed;
  }

  /**
   * The local runner belongs to the machine hosting the room, not to whoever
   * happened to join first — with `mpx serve` there may be no host seat at all,
   * and labelling it after a participant makes two different accounts look
   * like one.
   */
  private hostName(): string {
    return hostname() || "host";
  }

  private toPeer(runnerId: string, msg: ServerMessage): void {
    const peer = this.peers.get(runnerId);
    if (peer) peer.send(encode(msg));
  }

  private publishRunners(): void {
    // With pooling off there is exactly one account and nothing to choose
    // between, so the room says nothing about runners at all.
    if (!this.routed || !this.opts.pool) return;
    this.room.runners = this.routed.list();
    this.room.activeRunnerId = this.routed.active;
    this.broadcast({ t: "runners", runners: this.room.runners, activeId: this.room.activeRunnerId });
  }

  private publishLanes(): void {
    this.room.lanes = this.race ? this.race.list() : this.room.lanes;
    this.broadcast({ t: "lanes", lanes: this.room.lanes, laneCount: this.room.laneCount });
  }

  /* ---------------------------------------------------------------- */
  /* races                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Run one prompt in several worktrees at once, then hand the results to the
   * room to choose between.
   *
   * Only one race at a time: they are expensive, they all write to the same
   * repository, and a room voting on six diffs from two different questions is
   * a worse experience than waiting.
   */
  private async runRace(
    turnId: string,
    prompt: string,
    count: number,
    batch: Proposal[],
    pieces?: string[],
  ): Promise<void> {
    if (!this.repo) {
      this.room.notice("error", this.laneReason ?? "this room is not hosted in a git repository");
      return;
    }
    if (this.race) {
      this.room.notice("warn", "a race is already waiting on a decision — resolve it first");
      return;
    }
    // Lane ids are handed out in this order, so the pieces line up with A, B, C
    // in the order they were written — which is the order the room said them.
    const prompts: Record<string, string> | undefined = pieces
      ? Object.fromEntries(pieces.map((piece, i) => [LANE_IDS[i]!, piece.trim()]))
      : undefined;
    this.splitting = pieces !== undefined;

    const contributors = [...new Set(batch.map((p) => p.authorName))];
    this.room.lastTurnAuthors = new Set(batch.map((p) => p.authorId));
    this.room.turnCount += 1;
    const start: ServerMessage = { t: "turnStart", turnId, prompt, contributors };
    this.transcript.write(start);
    this.broadcast(start);
    this.room.setAgent({
      state: "streaming",
      turnId,
      detail: this.splitting ? `${count} lanes, split` : `${count} lanes`,
    });

    const race = new Race({
      repo: this.repo,
      roomName: this.opts.roomName,
      turnId,
      prompt,
      count,
      setup: this.opts.laneSetup,
      ...(prompts ? { prompts } : {}),
      preview: this.opts.lanePreview
        ? {
            command: this.opts.lanePreview,
            basePort: this.opts.lanePreviewPort ?? DEFAULT_BASE_PORT,
            host: this.opts.lanePreviewHost ?? DEFAULT_HOST,
            readyMs: DEFAULT_READY_MS,
          }
        : null,
      ...(this.opts.laneDir ? { baseDir: this.opts.laneDir } : {}),
      makeBackend: (lane) => this.laneBackend(lane.cwd, lane.id),
      onLaneChange: (lanes) => {
        this.room.lanes = lanes;
        this.publishLanes();
      },
      onDelta: (lane, kind, text) => this.fanout({ t: "delta", turnId, kind, text, lane }),
      onToolResult: (lane, toolUseId, ok, preview) =>
        this.fanout({ t: "toolResult", turnId, toolUseId, ok, preview, lane }),
      onNotice: (text) => this.room.notice("info", text),
    });
    this.race = race;

    this.abort = new AbortController();
    const lanes = await race.run(this.abort.signal).catch((err): LaneInfo[] => {
      this.room.notice("error", `race failed: ${(err as Error)?.message ?? String(err)}`);
      return [];
    });
    this.abort = null;

    const end: ServerMessage = { t: "turnEnd", turnId, stopReason: "lanes" };
    this.transcript.write(end);
    this.broadcast(end);
    this.room.setAgent({ state: "idle", turnId: null, detail: "" });

    const landable = race.landable();
    if (!landable.length) {
      this.room.notice("warn", describeBarren(lanes));
      await this.endRace();
      return;
    }

    // Only for a split. In a race the lanes are three tries at one thing, so of
    // course they touch the same files, and saying so would be noise. In a
    // split they are meant to land together, and two of them claiming one file
    // is either duplicated work or a merge conflict nobody has met yet.
    if (this.splitting) {
      const clash = describeOverlaps(findOverlaps(landable.map((l) => ({ id: l.id, paths: l.paths ?? [] }))));
      if (clash) this.room.notice("warn", clash);
    }

    // One proposal per lane, all open at once. In a race, voting for a lane is
    // voting to land it *instead of* the others; in a split it is voting to
    // land it as well as them, and each is decided on its own.
    for (const lane of landable) {
      const prop = this.room.proposeLane(lane);
      lane.proposalId = prop.id;
    }
    this.publishLanes();
  }

  private laneBackend(cwd: string, lane: string): AgentBackend {
    const participants = this.room.list().map((p) => p.name);
    if (this.opts.backendFactory) return this.opts.backendFactory({ participants, cwd, lane });
    return createBackend({
      backend: this.opts.backend,
      cwd,
      model: this.opts.model,
      maxTokens: this.opts.maxTokens,
      showThinking: this.opts.showThinking,
      systemPrompt: lanePrompt(
        multiplayerSystemPrompt(this.opts.systemPromptExtra, participants, cwd),
        lane,
      ),
      backendBin: this.opts.backendBin,
      backendArgs: this.opts.backendArgs,
      permissionMode: this.opts.permissionMode,
      // A lane is a fresh attempt from a clean branch, so it never resumes the
      // room's thread — and two lanes resuming the same thread would trample
      // each other's history.
      resume: null,
      attach: null,
    });
  }

  private async onLaneDecision(p: Proposal, allow: boolean, reason: string): Promise<void> {
    const race = this.race;
    const laneId = p.lane;
    if (!race || !laneId) return;
    if (this.splitting) return this.onSplitDecision(race, laneId, allow, reason);

    // A landing withdraws the other lanes, which arrives back here as a
    // rejection for each of them. That is bookkeeping, not the room deciding
    // against anything, so a race that already has a winner says nothing more.
    const settled = this.landing || race.list().some((l) => l.state === "landed");

    if (!allow) {
      if (settled) return;
      // Nothing left to land: tidy up and tell the room where the work went.
      if (!this.room.openProposals().some((o) => o.kind === "lane")) {
        this.room.notice("info", "no lane landed");
        await this.endRace();
      }
      return;
    }

    if (settled) {
      this.room.notice("warn", `lane ${laneId} was not landed — the room already landed another`);
      return;
    }

    this.landing = true;
    const landed = await race.land(laneId);
    if (!landed.ok) {
      // A merge that failed is not a decision: the other lanes stay on the
      // table, and the room can approve one of those instead.
      this.landing = false;
      this.room.notice("error", `lane ${laneId} did not land — ${landed.error}`);
      this.publishLanes();
      return;
    }
    this.room.notice("info", `lane ${laneId} landed on ${this.repo?.branch ?? "HEAD"} (${reason})`);
    this.room.closeOtherLanes(laneId, `lane ${laneId} landed`);
    race.markDiscarded(laneId);
    await this.endRace();
  }

  /**
   * The same decision, for lanes that are not competing.
   *
   * Nothing is withdrawn here: approving the backend lane says nothing about
   * the frontend one, and a room that had to re-open the other half after
   * taking the first would have learned to stop splitting. The race ends when
   * the room has decided about every lane, not when it has decided about one.
   */
  private async onSplitDecision(race: Race, laneId: string, allow: boolean, reason: string): Promise<void> {
    if (allow) {
      // Queued rather than concurrent: two merges at once in one checkout is a
      // corrupted index, and the second lane's conflicts are only knowable
      // after the first has landed anyway.
      this.landChain = this.landChain.then(async () => {
        if (!this.race) return;
        const landed = await race.land(laneId);
        if (!landed.ok) {
          this.room.notice(
            "error",
            `lane ${laneId} did not land — ${landed.error}. Its work is on ${race.list().find((l) => l.id === laneId)?.branch ?? "its branch"}`,
          );
        } else {
          this.room.notice("info", `lane ${laneId} landed on ${this.repo?.branch ?? "HEAD"} (${reason})`);
        }
        this.publishLanes();
        await this.endSplitIfSettled();
      });
      await this.landChain;
      return;
    }

    await race.discard(laneId);
    this.publishLanes();
    await this.endSplitIfSettled();
  }

  /** A split is over once no lane is still waiting on the room. */
  private async endSplitIfSettled(): Promise<void> {
    if (!this.race) return;
    if (this.room.openProposals().some((o) => o.kind === "lane")) return;
    const landed = this.race.list().filter((l) => l.state === "landed").length;
    if (!landed) this.room.notice("info", "no lane landed");
    await this.endRace();
  }

  /** Dispose of the checkouts, and say where the branches are. */
  private async endRace(): Promise<void> {
    const race = this.race;
    if (!race) return;
    this.race = null;
    this.landing = false;
    this.splitting = false;
    this.landChain = Promise.resolve();
    const branches = await race.close();
    this.room.lanes = race.list();
    this.publishLanes();
    if (branches.length) {
      this.room.notice("info", `lane branches kept: ${branches.join(", ")} — delete with git branch -D`);
    }
  }

  private ensureBackend(): AgentBackend {
    if (this.backend) return this.backend;
    const participants = this.room.list().map((p) => p.name);
    if (this.opts.backendFactory) {
      this.backend = this.opts.backendFactory({ participants, cwd: this.opts.cwd });
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
    // Some CLIs have no way to hand a session from one invocation to the next.
    // The room is still one conversation to the people in it, but not to the
    // model, and that is worth saying before anyone relies on it.
    if (!carriesSession(this.opts.backend)) {
      this.room.notice(
        "warn",
        `${this.opts.backend} starts a fresh session each turn — it cannot carry the conversation between them`,
      );
    }
    return this.backend;
  }

  /** Drain the approved queue, one turn at a time. */
  private async pump(): Promise<void> {
    if (this.closed) return;
    if (this.room.agent.state !== "idle" && this.room.agent.state !== "error") return;
    const batch = this.room.takeQueued();
    if (!batch.length) return;

    const turnId = id("turn", 6);
    const prompt = this.room.composeTurn(batch);
    const only = batch.length === 1 ? batch[0]! : null;
    if (only?.split) {
      await this.runRace(turnId, prompt, only.split.length, batch, only.split);
      if (this.room.queuedIds().length) void this.pump();
      return;
    }
    if (only?.race) {
      await this.runRace(turnId, prompt, only.race, batch);
      if (this.room.queuedIds().length) void this.pump();
      return;
    }

    const backend = this.ensureRouted();
    const contributors = [...new Set(batch.map((p) => p.authorName))];
    this.room.lastTurnAuthors = new Set(batch.map((p) => p.authorId));
    this.room.turnCount += 1;

    const start: ServerMessage = { t: "turnStart", turnId, prompt, contributors };
    this.transcript.write(start);
    this.broadcast(start);
    this.room.setAgent({ state: "thinking", turnId, detail: "" });

    this.abort = new AbortController();
    let sawText = false;
    // Any backend at all can raise a fork, because every backend streams text
    // and the block is in the text. Only some of them can be held while the
    // room answers; the rest are answered in their next turn.
    const forks = new CrossroadsStream();
    const raise = (found: ParsedCrossroads[]) => {
      for (const f of found) this.raiseCrossroads(f, false);
    };

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
            const step = forks.push(text);
            raise(step.found);
            if (!step.text) return;
            this.fanout({ t: "delta", turnId, kind: "text", text: step.text });
          },
          onThinking: (text) => {
            if (text) this.fanout({ t: "delta", turnId, kind: "thinking", text });
          },
          onToolRequest: (req) => this.voteOnTool(turnId, req),
          onToolResult: (toolUseId, ok, preview) => {
            this.fanout({ t: "toolResult", turnId, toolUseId, ok, preview });
          },
          onNotice: (text) => this.room.notice("info", text),
          onCrossroads: (question, options) => this.blockingCrossroads(question, options),
        },
        this.abort.signal,
      )
      .catch((err): TurnResult => ({
        stopReason: "error",
        error: (err as Error)?.message ?? String(err),
      }));

    // A turn that ended mid-block never had a block; show what it wrote.
    const tail = forks.flush();
    if (tail) this.fanout({ t: "delta", turnId, kind: "text", text: tail });
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

  /* ---------------------------------------------------------------- */
  /* crossroads                                                        */
  /* ---------------------------------------------------------------- */

  private raiseCrossroads(f: ParsedCrossroads, blocking: boolean): boolean {
    const asked = this.room.ask(
      "agent",
      this.room.agent.backend || "the agent",
      f.question,
      f.options,
      blocking,
    );
    if ("error" in asked) {
      this.room.notice("warn", `could not put that fork to the room — ${asked.error}`);
      return false;
    }
    this.room.notice(
      "info",
      blocking
        ? "the turn is paused until the room picks a direction"
        : "the room's answer will go back as the next message",
    );
    return true;
  }

  /**
   * Hold the turn open while the room decides.
   *
   * Only backends that call `onCrossroads` get this — which today means the
   * one whose tool loop this process owns. Everything else has already
   * streamed its answer by the time we see the block, and pretending we paused
   * a process we cannot pause would be worse than being honest about it.
   */
  private blockingCrossroads(question: string, options: string[]): Promise<string | null> {
    const raised = this.raiseCrossroads(
      { question, options: options.map((label) => ({ label })) },
      true,
    );
    if (!raised) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pendingChoice = resolve;
    });
  }

  private onChoiceDecision(p: Proposal, allow: boolean, reason: string): void {
    const info = this.room.crossroads;
    if (!info || info.state !== "open" || !p.option) return;

    if (!allow) {
      // Every option voted down is a real outcome: the room looked at the fork
      // and declined to pick, which the agent needs told rather than hidden.
      if (this.room.openProposals().some((o) => o.kind === "choice")) return;
      this.room.abandonCrossroads("no direction chosen");
      this.settleChoice(info.question, null, "the room did not pick a direction");
      return;
    }

    const option = info.options.find((o) => o.id === p.option);
    this.room.settleCrossroads(p.option, `the room chose ${p.option}`);
    this.room.notice("info", `the room chose ${p.option}: ${option?.label ?? ""} (${reason})`);
    this.settleChoice(info.question, option?.label ?? p.option, null);
  }

  /** Deliver the answer, whichever way the backend is able to receive it. */
  private settleChoice(question: string, label: string | null, why: string | null): void {
    const waiting = this.pendingChoice;
    if (waiting) {
      this.pendingChoice = null;
      waiting(label);
      return;
    }
    // Nothing is holding a turn, so the answer becomes the next message.
    const text = label
      ? `The room decided: ${label}.\n\n(You asked: ${question}.) Carry on from there — do not ask again unless something new makes it a genuine fork.`
      : `The room looked at your question — ${question} — and did not pick a direction (${why ?? "no option carried"}). Use your judgement, and say plainly which way you went and why.`;
    this.room.injectTurn(text, "the room");
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
    this.pendingChoice?.(null);
    this.pendingChoice = null;
    for (const [key, resolve] of this.pendingTools) {
      this.pendingTools.delete(key);
      resolve({ allow: false, reason: "room closing" });
    }
    this.room.close();
    await this.race?.close().catch(() => []);
    this.race = null;
    await this.routed?.close();
    this.routed = null;
    for (const peer of this.peers.values()) peer.close(1001, "room closed");
    this.peers.clear();
    // Including the ones that never became seats.
    for (const socket of this.sockets) socket.close(1001, "room closed");
    this.sockets.clear();
    await this.transport.close();
    await this.transcript.close();
  }
}

/**
 * What a lane's agent is told, on top of the room's usual system prompt.
 *
 * A lane cannot ask a follow-up question: nobody is watching it individually,
 * and the room only ever sees the diff. So the instruction is to commit to an
 * approach and carry it out rather than to check in.
 */
function lanePrompt(base: string, lane: string): string {
  return [
    base,
    "",
    `You are lane ${lane}: one of several agents attempting this same task in parallel, each in its own git worktree.`,
    "Nobody is watching your lane on its own — the room compares the finished diffs and votes on which one to keep.",
    "So: pick an approach, carry it out end to end, and leave the working tree in the state you want judged.",
    "Do not ask questions and do not wait for approval. If the task is ambiguous, choose the reading you think is best and say which one you chose.",
  ].join("\n");
}

/** Explain an empty race, which is a result rather than a malfunction. */
function describeBarren(lanes: LaneInfo[]): string {
  const failed = lanes.filter((l) => l.state === "failed");
  const empty = lanes.filter((l) => l.state === "empty");
  const bits: string[] = [];
  if (empty.length) bits.push(`${empty.length} changed nothing`);
  if (failed.length) bits.push(`${failed.length} failed (${failed[0]!.error ?? "no detail"})`);
  return `no lane produced changes to vote on — ${bits.join(", ") || "nothing to land"}`;
}

/** How long a new socket has to prove it belongs before it is dropped. */
const HANDSHAKE_MS = 10_000;

function err(fail: (t: string) => void, e: string | null): void {
  if (e) fail(e);
}
