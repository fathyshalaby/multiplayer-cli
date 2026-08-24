import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../protocol.js";
import { id } from "../util/id.js";

export interface RelayOptions {
  host: string;
  port: number;
  /** Reject a new room whose name is already registered. */
  maxRooms: number;
  /** Cap concurrent seats per room, so one room cannot exhaust the relay. */
  maxPeersPerRoom: number;
  /** Join attempts allowed per room per minute. */
  joinsPerMinute: number;
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
 * are multiplexed onto that one connection. The relay deliberately knows as
 * little as possible: it never learns the room token, never inspects a frame,
 * and cannot admit anyone — every seat still has to satisfy the host's own
 * `hello` check, which happens end-to-end through this pipe.
 *
 * It is still a machine in the middle of your session's plaintext. Run your
 * own, and put TLS in front of it.
 */
export class Relay {
  private http: Server;
  private wss: WebSocketServer;
  private rooms = new Map<string, RelayRoom>();
  private opts: RelayOptions;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    this.http = createServer((req, res) => {
      if (req.url?.startsWith("/health")) {
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
    });

    this.wss = new WebSocketServer({ server: this.http });
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
      return this.acceptPeer(ws, name, url.search.replace(/^\?/, ""));
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

  private acceptPeer(ws: WebSocket, name: string, query: string): void {
    const room = this.rooms.get(name);
    if (!room) {
      ws.close(4404, `no room named "${name}" is hosted here`);
      return;
    }
    if (room.peers.size >= this.opts.maxPeersPerRoom) {
      ws.close(4429, "room is full");
      return;
    }
    // The relay cannot check the room token — it never has it — so it limits
    // how fast anyone may try, and lets the host reject the rest.
    const now = Date.now();
    room.joinTimes = room.joinTimes.filter((t) => now - t < 60_000);
    if (room.joinTimes.length >= this.opts.joinsPerMinute) {
      ws.close(4429, "too many join attempts, wait a minute");
      return;
    }
    room.joinTimes.push(now);

    const channel = id("c", 6);
    room.peers.set(channel, ws);
    send(room.host, { c: 0, ctl: "open", id: channel, q: query });

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
