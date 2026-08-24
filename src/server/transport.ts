import { createServer, type IncomingMessage, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../protocol.js";
import { id } from "../util/id.js";

/**
 * One connected seat, independent of how it got here.
 *
 * A peer may be a real socket on the host's port or a multiplexed channel
 * arriving through a relay. The room cannot tell the difference, which is the
 * point: authentication and every rule stay with the host either way.
 */
export interface Peer {
  readonly id: string;
  /** Query supplied at connect time. The host checks the room token from it. */
  readonly query: URLSearchParams;
  send(frame: string): void;
  close(code: number, reason: string): void;
  onMessage(cb: (raw: string) => void): void;
  onClose(cb: () => void): void;
}

export interface TransportInfo {
  /** The command teammates run, already carrying the token. */
  joinUrl(token: string | null): string;
  /** Extra invite lines — a LAN address, a tunnel hint, a relay note. */
  detail(token: string | null): string[];
}

export interface Transport {
  start(): Promise<TransportInfo>;
  onPeer(cb: (peer: Peer) => void): void;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* direct: the host listens, teammates connect to it                   */
/* ------------------------------------------------------------------ */

export interface LocalTransportOptions {
  host: string;
  port: number;
  roomName: string;
}

export class LocalWsTransport implements Transport {
  private http: Server;
  private wss: WebSocketServer;
  private cb: ((peer: Peer) => void) | null = null;
  private opts: LocalTransportOptions;
  private bound = 0;

  constructor(opts: LocalTransportOptions) {
    this.opts = opts;
    this.http = createServer((req, res) => {
      if (req.url?.startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, room: opts.roomName, protocol: PROTOCOL_VERSION }));
        return;
      }
      res.writeHead(404).end("multiplayer-cli: connect with `mpx join`");
    });
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws, req) => this.cb?.(socketPeer(ws, req)));
  }

  onPeer(cb: (peer: Peer) => void): void {
    this.cb = cb;
  }

  async start(): Promise<TransportInfo> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port, this.opts.host, () => {
        this.http.removeListener("error", reject);
        resolve();
      });
    });
    const addr = this.http.address();
    this.bound = typeof addr === "object" && addr ? addr.port : this.opts.port;
    const host = this.opts.host;
    const port = this.bound;

    return {
      joinUrl: (token) => wsUrl(host === "0.0.0.0" ? "127.0.0.1" : host, port, token),
      detail: (token) => {
        const lines: string[] = [];
        const lan = lanAddress();
        if (host === "0.0.0.0" && lan) {
          lines.push(`on your network:  mpx join ${wsUrl(lan, port, token)}`);
        }
        if (host === "127.0.0.1") {
          lines.push(`remote teammate:  ssh -R ${port}:localhost:${port} them@host`);
          lines.push(`no tunnel:        add --relay wss://your-relay  (see \`mpx relay --help\`)`);
        }
        return lines;
      },
    };
  }

  get port(): number {
    return this.bound;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}

function socketPeer(ws: WebSocket, req: IncomingMessage): Peer {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    id: id("p", 6),
    query: url.searchParams,
    send: (frame) => {
      if (ws.readyState === ws.OPEN) ws.send(frame);
    },
    close: (code, reason) => ws.close(code, reason),
    onMessage: (cb) => ws.on("message", (raw) => cb(raw.toString())),
    onClose: (cb) => {
      ws.on("close", cb);
      ws.on("error", cb);
    },
  };
}

/* ------------------------------------------------------------------ */
/* relay: the host dials out, teammates connect to the relay           */
/* ------------------------------------------------------------------ */

export interface RelayTransportOptions {
  /** Relay base URL, e.g. wss://relay.example.com */
  url: string;
  roomName: string;
  onWarn?: (text: string) => void;
}

/**
 * Serves the room through a relay the host dials *out* to.
 *
 * This is the difference between "send them an SSH command" and "send them a
 * link". No inbound port, no tunnel, nothing to open on the host's network.
 * The relay is a dumb pipe: it never sees the room token, never validates a
 * vote, and cannot admit anyone the host would not have admitted, because
 * every frame still terminates at the host's own rules.
 */
export class RelayTransport implements Transport {
  private ws: WebSocket | null = null;
  private cb: ((peer: Peer) => void) | null = null;
  private peers = new Map<string, RelayPeer>();
  private opts: RelayTransportOptions;
  private closing = false;
  private onReady: (() => void) | null = null;

  constructor(opts: RelayTransportOptions) {
    this.opts = opts;
  }

  onPeer(cb: (peer: Peer) => void): void {
    this.cb = cb;
  }

  async start(): Promise<TransportInfo> {
    const base = normalize(this.opts.url);
    const hostUrl = `${base}/host?room=${encodeURIComponent(this.opts.roomName)}&protocol=${PROTOCOL_VERSION}`;
    await this.dial(hostUrl);

    return {
      joinUrl: (token) => `${base}/r/${encodeURIComponent(this.opts.roomName)}${token ? `?t=${token}` : ""}`,
      detail: () => [`relayed through ${base} — the relay carries frames, the host still decides`],
    };
  }

  private dial(hostUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(hostUrl, { handshakeTimeout: 15_000 });
      this.ws = ws;
      let settled = false;

      // The upgrade succeeding only means the relay is listening. Registration
      // is confirmed by a `ready` control frame, so wait for that before
      // telling the host it has a room to invite people to.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close(1000, "no ready");
        reject(new Error(`the relay at ${this.opts.url} accepted the connection but never confirmed the room`));
      }, 15_000);
      timer.unref?.();

      this.onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      ws.on("message", (raw) => this.onFrame(raw.toString()));

      ws.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`could not reach the relay at ${this.opts.url}: ${(err as Error).message}`));
        } else {
          this.opts.onWarn?.(`relay error: ${(err as Error).message}`);
        }
      });

      ws.on("close", (code, reason) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`relay refused the room: ${reason.toString() || `code ${code}`}`));
          return;
        }
        // Everyone came in through the relay, so losing it drops the room.
        for (const peer of this.peers.values()) peer.fireClose();
        this.peers.clear();
        if (!this.closing) {
          this.opts.onWarn?.(`relay disconnected (${reason.toString() || code}) — teammates will need a new invite`);
        }
      });
    });
  }

  private onFrame(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.c === 0) {
      if (msg.ctl === "ready") {
        this.onReady?.();
        return;
      }
      if (msg.ctl === "open" && typeof msg.id === "string") {
        const peer = new RelayPeer(msg.id, new URLSearchParams(String(msg.q ?? "")), (frame) => {
          this.ws?.send(JSON.stringify({ c: msg.id, d: frame }));
        }, (code, reason) => {
          this.ws?.send(JSON.stringify({ c: 0, ctl: "close", id: msg.id, code, reason }));
          this.peers.delete(msg.id);
        });
        this.peers.set(msg.id, peer);
        this.cb?.(peer);
        return;
      }
      if (msg.ctl === "close" && typeof msg.id === "string") {
        const peer = this.peers.get(msg.id);
        this.peers.delete(msg.id);
        peer?.fireClose();
        return;
      }
      if (msg.ctl === "notice" && typeof msg.text === "string") {
        this.opts.onWarn?.(String(msg.text));
      }
      return;
    }
    if (typeof msg?.c === "string" && typeof msg?.d === "string") {
      this.peers.get(msg.c)?.fireMessage(msg.d);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.ws?.close(1000, "room closed");
    this.ws = null;
    this.peers.clear();
  }
}

class RelayPeer implements Peer {
  private msgCb: ((raw: string) => void) | null = null;
  private closeCb: (() => void) | null = null;
  private open = true;

  constructor(
    readonly id: string,
    readonly query: URLSearchParams,
    private write: (frame: string) => void,
    private shut: (code: number, reason: string) => void,
  ) {}

  send(frame: string): void {
    if (this.open) this.write(frame);
  }
  close(code: number, reason: string): void {
    if (!this.open) return;
    this.open = false;
    this.shut(code, reason);
  }
  onMessage(cb: (raw: string) => void): void {
    this.msgCb = cb;
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  fireMessage(raw: string): void {
    this.msgCb?.(raw);
  }
  fireClose(): void {
    if (!this.open) return;
    this.open = false;
    this.closeCb?.();
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function wsUrl(host: string, port: number, token: string | null): string {
  return `ws://${host}:${port}/${token ? `?t=${token}` : ""}`;
}

export function lanAddress(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return null;
}

/** Accept http/https/ws/wss or a bare host, and drop any trailing slash. */
export function normalize(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (u.startsWith("http://")) u = "ws://" + u.slice(7);
  else if (u.startsWith("https://")) u = "wss://" + u.slice(8);
  else if (!u.startsWith("ws://") && !u.startsWith("wss://")) u = "wss://" + u;
  return u;
}
