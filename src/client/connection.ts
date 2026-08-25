import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../protocol.js";
import { PROTOCOL_VERSION, decode, encode } from "../protocol.js";
import { deriveKey } from "../core/crypto.js";
import { SecureChannel } from "../core/secure.js";

export interface ConnectionOptions {
  url: string;
  name: string;
  observer?: boolean;
  /** Reconnect with backoff when the room drops. */
  reconnect?: boolean;
  /**
   * The room token. Used only as an encryption key — it is never sent, so a
   * relay or a proxy in the path never sees it.
   */
  token?: string | null;
  /** Room name, which keys the encryption alongside the token. */
  room?: string;
}

/**
 * Thin, reconnecting WebSocket client. Emits parsed `ServerMessage`s and hides
 * the difference between "the host's laptop slept" and "the room is gone".
 */
export class Connection extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: ConnectionOptions;
  private attempt = 0;
  private closedByUs = false;
  private heartbeat: NodeJS.Timeout | null = null;
  /** Typed before the socket opened, or during a reconnect. Sent on open. */
  private outbox: ClientMessage[] = [];
  private channel: SecureChannel;

  constructor(opts: ConnectionOptions) {
    super();
    this.opts = opts;
    this.channel = this.freshChannel();
  }

  /** A reconnect is a new link, so it gets new sequence numbers. */
  private freshChannel(): SecureChannel {
    const { token, room } = this.opts;
    return new SecureChannel(token ? deriveKey(token, room ?? "") : null);
  }

  /** True when this link is end-to-end encrypted. */
  get encrypted(): boolean {
    return this.channel.encrypted;
  }

  connect(): void {
    this.closedByUs = false;
    this.channel = this.freshChannel();
    const ws = new WebSocket(this.opts.url, { handshakeTimeout: 10_000 });
    this.ws = ws;

    ws.on("open", () => {
      this.attempt = 0;
      this.send({
        t: "hello",
        name: this.opts.name,
        protocol: PROTOCOL_VERSION,
        ...(this.opts.observer ? { observer: true } : {}),
      });
      this.heartbeat = setInterval(() => this.send({ t: "ping" }), 25_000);
      this.heartbeat.unref?.();
      const queued = this.outbox.splice(0);
      for (const msg of queued) ws.send(this.channel.wrap(encode(msg)));
      this.emit("open");
    });

    ws.on("message", (raw) => {
      const plain = this.channel.unwrap(raw.toString());
      if (plain === null) {
        // Either the room has a different token, or something in the path is
        // rewriting frames. Neither is worth continuing through.
        this.emit("warn", "a frame from the room did not authenticate — wrong token, or something is tampering with the connection");
        this.close();
        return;
      }
      const msg = decode<ServerMessage>(plain);
      if (msg) this.emit("message", msg);
    });

    ws.on("error", (err) => this.emit("warn", (err as Error).message));

    ws.on("close", (code, reason) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.ws = null;
      const why = reason.toString() || `code ${code}`;
      if (this.closedByUs) return this.emit("closed", why);
      // 4003/4004 are our own refusals; retrying will not help.
      if (code === 4003 || code === 4004 || !this.opts.reconnect) {
        return this.emit("closed", why);
      }
      this.attempt += 1;
      if (this.attempt > 6) return this.emit("closed", `gave up reconnecting (${why})`);
      const delay = Math.min(16_000, 500 * 2 ** (this.attempt - 1));
      this.emit("warn", `disconnected (${why}) — retrying in ${Math.round(delay / 1000)}s`);
      const t = setTimeout(() => this.connect(), delay);
      t.unref?.();
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(this.channel.wrap(encode(msg)));
      return;
    }
    // Hold it rather than lose it — but never queue a heartbeat or a stale
    // hello, which would arrive out of order after a reconnect.
    if (msg.t === "ping" || msg.t === "hello") return;
    if (this.outbox.length < 50) this.outbox.push(msg);
  }

  close(): void {
    this.closedByUs = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.ws?.close(1000, "bye");
    this.ws = null;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
