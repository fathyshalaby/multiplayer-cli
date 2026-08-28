import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../protocol.js";
import { id } from "../util/id.js";
import { serveWeb } from "./web.js";

/**
 * Generous for a room, small for an attacker: 8 MiB is more than a hundred
 * times the largest frame a real session produces, and a twelfth of what `ws`
 * allows by default.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface RelayOptions {
  host: string;
  port: number;
  /** PEM cert and key, so the relay serves wss:// without a reverse proxy. */
  tls?: { cert: string; key: string } | null;
  /** Reject a new room whose name is already registered. */
  maxRooms: number;
  /** Cap concurrent seats per room, so one room cannot exhaust the relay. */
  maxPeersPerRoom: number;
  /** Join attempts allowed per room per minute. */
  joinsPerMinute: number;
  /**
   * Largest frame the relay will accept, in bytes.
   *
   * `ws` defaults to 100 MiB, which is four orders of magnitude more than a
   * room frame — sealed JSON, a few kilobytes, a few hundred at the very worst
   * for a snapshot of a long session. At the default limits a relay accepts 64
   * rooms of 32 seats, and every one of those sockets could hand it 100 MiB
   * that it buffers and then stringifies to forward. The docs suggest running
   * one of these on a small VPS for other people; it should not be possible to
   * exhaust that by connecting to it and talking.
   */
  maxFrameBytes?: number;
  /**
   * Publish the names of hosted rooms at `GET /rooms`.
   *
   * Off by default: a room name is metadata, and a relay that lists them tells
   * anyone who asks what this team is working on. Knowing a name grants
   * nothing — the host still has to be satisfied — but it is a disclosure, so
   * it is a choice rather than a default.
   */
  directory: boolean;
  onLog?: (line: string) => void;
}

interface RelayRoom {
  name: string;
  host: WebSocket;
  peers: Map<string, WebSocket>;
  createdAt: number;
  joinTimes: number[];
}

/**
 * A dumb pipe that lets a room be reachable without an inbound port.
 *
 * The host dials *out* and registers a room; teammates connect to the relay and
 * are multiplexed onto that one connection.
 *
 * The relay cannot read the session. Frames are sealed end-to-end with the room
 * token before they get here, so what passes through is ciphertext with a
 * channel number attached. It never learns the token, cannot admit anyone the
 * host would refuse, and cannot alter a frame without the receiver rejecting
 * it. Running someone else's relay costs you traffic metadata — who is
 * connected, how much they say, when — and nothing else.
 */
export class Relay {
  private http: Server;
  private wss: WebSocketServer;
  private rooms = new Map<string, RelayRoom>();
  private opts: RelayOptions;
  private secure = false;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://relay").pathname;
      // A shared link lands here. Serving the seat from the relay is what makes
      // the link worth clicking for someone with nothing installed.
      if (serveWeb(pathname, res)) return;
      if (pathname === "/rooms") {
        if (!this.opts.directory) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "this relay does not publish a directory" }));
          return;
        }
        const now = Date.now();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            rooms: [...this.rooms.values()].map((r) => ({
              name: r.name,
              seats: r.peers.size,
              // Age rather than a timestamp: enough to see what is live,
              // without publishing exactly when a team started work.
              upSeconds: Math.round((now - r.createdAt) / 1000),
            })),
          }),
        );
        return;
      }
      if (pathname.startsWith("/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            protocol: PROTOCOL_VERSION,
            rooms: this.rooms.size,
            capacity: this.opts.maxRooms,
          }),
        );
        return;
      }
      res.writeHead(404).end("multiplayer-cli relay");
    };
    this.http = opts.tls
      ? (createTlsServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) as unknown as Server)
      : createServer(handler);
    this.secure = Boolean(opts.tls);

    this.wss = new WebSocketServer({
      server: this.http,
      maxPayload: this.opts.maxFrameBytes ?? MAX_FRAME_BYTES,
    });
    this.wss.on("connection", (ws, req) => this.route(ws, req));
  }

  private log(line: string): void {
    this.opts.onLog?.(line);
  }

  private route(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url ?? "/", "http://relay");
    if (url.pathname === "/host") return this.acceptHost(ws, url);
    if (url.pathname.startsWith("/r/")) {
      const name = decodeURIComponent(url.pathname.slice(3));
      return this.acceptPeer(ws, name);
    }
    ws.close(4404, "unknown path");
  }

  private acceptHost(ws: WebSocket, url: URL): void {
    const name = url.searchParams.get("room") ?? "";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
      ws.close(4400, "bad room name");
      return;
    }
    if (url.searchParams.get("protocol") !== String(PROTOCOL_VERSION)) {
      ws.close(4004, `relay speaks protocol v${PROTOCOL_VERSION}`);
      return;
    }
    if (this.rooms.has(name)) {
      ws.close(4409, `room "${name}" is already hosted here`);
      return;
    }
    if (this.rooms.size >= this.opts.maxRooms) {
      ws.close(4429, "relay is at capacity");
      return;
    }

    const room: RelayRoom = { name, host: ws, peers: new Map(), createdAt: Date.now(), joinTimes: [] };
    this.rooms.set(name, room);
    // Acknowledge explicitly. A WebSocket upgrade succeeding says nothing about
    // whether the room was accepted, and the host must not print an invite for
    // a room this relay just refused.
    send(ws, { c: 0, ctl: "ready", room: name });
    this.log(`+ room ${name} (${this.rooms.size} hosted)`);

    ws.on("message", (raw) => this.fromHost(room, raw.toString()));
    const drop = () => {
      if (this.rooms.get(name) !== room) return;
      this.rooms.delete(name);
      // The host is the room. Without it there is nothing to relay to.
      for (const peer of room.peers.values()) peer.close(1001, "room host disconnected");
      room.peers.clear();
      this.log(`- room ${name} (${this.rooms.size} hosted)`);
    };
    ws.on("close", drop);
    ws.on("error", drop);
  }

  private fromHost(room: RelayRoom, raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg?.c === 0 && msg.ctl === "close" && typeof msg.id === "string") {
      const peer = room.peers.get(msg.id);
      room.peers.delete(msg.id);
      peer?.close(typeof msg.code === "number" ? msg.code : 1000, String(msg.reason ?? ""));
      return;
    }
    if (typeof msg?.c === "string" && typeof msg?.d === "string") {
      const peer = room.peers.get(msg.c);
      if (peer?.readyState === peer?.OPEN) peer!.send(msg.d);
    }
  }

  private acceptPeer(ws: WebSocket, name: string): void {
    const room = this.rooms.get(name);
    if (!room) {
      ws.close(4404, `no room named "${name}" is hosted here`);
      return;
    }
    if (room.peers.size >= this.opts.maxPeersPerRoom) {
      ws.close(4429, "room is full");
      return;
    }
    // The relay has no way to tell a real seat from a stranger — that is
    // settled end-to-end by whether their frames decrypt — so it limits how
    // fast anyone may try and lets the host reject the rest.
    const now = Date.now();
    room.joinTimes = room.joinTimes.filter((t) => now - t < 60_000);
    if (room.joinTimes.length >= this.opts.joinsPerMinute) {
      ws.close(4429, "too many join attempts, wait a minute");
      return;
    }
    room.joinTimes.push(now);

    const channel = id("c", 6);
    room.peers.set(channel, ws);
    // Nothing about the joiner is forwarded but the channel number. Anything
    // else would be the relay vouching for someone, which it cannot do.
    send(room.host, { c: 0, ctl: "open", id: channel });

    ws.on("message", (raw) => send(room.host, { c: channel, d: raw.toString() }));
    const bye = () => {
      if (!room.peers.delete(channel)) return;
      send(room.host, { c: 0, ctl: "close", id: channel });
    };
    ws.on("close", bye);
    ws.on("error", bye);
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port, this.opts.host, () => {
        this.http.removeListener("error", reject);
        resolve();
      });
    });
    const addr = this.http.address();
    return typeof addr === "object" && addr ? addr.port : this.opts.port;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  /** True when this relay terminates TLS itself. */
  get isSecure(): boolean {
    return this.secure;
  }

  async close(): Promise<void> {
    for (const room of this.rooms.values()) {
      for (const peer of room.peers.values()) peer.close(1001, "relay shutting down");
      room.host.close(1001, "relay shutting down");
    }
    this.rooms.clear();
    await new Promise<void>((r) => this.wss.close(() => r()));
    await new Promise<void>((r) => this.http.close(() => r()));
  }
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
