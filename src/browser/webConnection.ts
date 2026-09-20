import type { ClientMessage, ServerMessage } from "../protocol.js";
import { PROTOCOL_VERSION, decode, encode } from "../protocol.js";
import { deriveAuthKeyWeb } from "./webCrypto.js";
import { WebSecureChannel } from "./webSecure.js";

export interface WebConnectionOptions {
  url: string;
  name: string;
  observer?: boolean;
  token?: string | null;
  room?: string;
}

type Listener<T> = (arg: T) => void;

/**
 * `client/connection.ts`'s `Connection`, rebuilt for a browser extension:
 * `WebSecureChannel` instead of `SecureChannel`, the native `WebSocket`
 * global instead of the `ws` npm package (both browsers and Node ≥22 have
 * it), and a small built-in listener list instead of `node:events`, which a
 * service worker does not have.
 *
 * Every WebCrypto operation is async, which the Node version's is not — that
 * is the one real shape difference from `Connection`, and it has a sharp
 * edge: `send()` must not let two overlapping calls seal their frames out of
 * order, since the receiving `SeqGuard` drops anything that arrives out of
 * sequence. Sends are threaded through `sendChain` for that reason — see the
 * ordering test in `webConnection.test.ts`.
 *
 * Reconnect-with-backoff and the ping heartbeat from `Connection` are not
 * ported yet; this proves the join and message loop, which is what a runner
 * seat needs first.
 */
export class WebConnection {
  private ws: WebSocket | null = null;
  private opts: WebConnectionOptions;
  private channel: WebSecureChannel | null = null;
  private outbox: ClientMessage[] = [];
  private sendChain: Promise<void> = Promise.resolve();

  private openCbs: Listener<void>[] = [];
  private messageCbs: Listener<ServerMessage>[] = [];
  private warnCbs: Listener<string>[] = [];
  private closedCbs: Listener<string>[] = [];

  constructor(opts: WebConnectionOptions) {
    this.opts = opts;
  }

  on(event: "open", cb: Listener<void>): void;
  on(event: "message", cb: Listener<ServerMessage>): void;
  on(event: "warn", cb: Listener<string>): void;
  on(event: "closed", cb: Listener<string>): void;
  on(event: string, cb: Listener<any>): void {
    if (event === "open") this.openCbs.push(cb);
    else if (event === "message") this.messageCbs.push(cb);
    else if (event === "warn") this.warnCbs.push(cb);
    else if (event === "closed") this.closedCbs.push(cb);
  }

  get connected(): boolean {
    return this.ws?.readyState === (globalThis.WebSocket as typeof WebSocket).OPEN;
  }

  get encrypted(): boolean {
    return !!this.opts.token;
  }

  async connect(): Promise<void> {
    const authKey = this.opts.token ? await deriveAuthKeyWeb(this.opts.token, this.opts.room ?? "") : null;
    this.channel = new WebSecureChannel(authKey, this.opts.room ?? "", "client");

    const WS = globalThis.WebSocket as typeof WebSocket;
    const ws = new WS(this.opts.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      void this.onOpen();
    });

    ws.addEventListener("message", (ev: MessageEvent) => {
      void this.onFrame(String(ev.data));
    });

    ws.addEventListener("error", () => {
      this.warnCbs.forEach((cb) => cb("websocket error"));
    });

    // `lib: ES2023` carries no DOM types, so `CloseEvent` is not a known name here
    // even though the runtime (browser or Node ≥22) passes a real one.
    ws.addEventListener("close", (ev: { code: number; reason: string }) => {
      this.ws = null;
      const why = ev.reason || `code ${ev.code}`;
      this.closedCbs.forEach((cb) => cb(why));
    });
  }

  private async onOpen(): Promise<void> {
    const channel = this.channel!;
    const first = await channel.begin();
    if (first) this.ws?.send(first);
    this.queueHello();
    if (!channel.encrypted) await this.flush();
  }

  private async onFrame(frame: string): Promise<void> {
    const channel = this.channel;
    if (!channel) return;

    if (channel.encrypted && !channel.ready) {
      if (!WebSecureChannel.isHandshake(frame)) return;
      const step = await channel.handshake(frame);
      if (!step.ok) {
        this.warnCbs.forEach((cb) =>
          cb("the room did not answer the handshake correctly — wrong link, or something is intercepting the connection"),
        );
        this.close();
        return;
      }
      if (step.reply) this.ws?.send(step.reply);
      if (step.ready) await this.flush();
      return;
    }

    const plain = await channel.unwrap(frame);
    if (plain === null) {
      this.warnCbs.forEach((cb) => cb("a frame from the room did not authenticate — wrong token, or something is tampering with the connection"));
      this.close();
      return;
    }
    const msg = decode<ServerMessage>(plain);
    if (msg) this.messageCbs.forEach((cb) => cb(msg));
  }

  /** Serialized so overlapping calls cannot seal their frames out of order. */
  send(msg: ClientMessage): Promise<void> {
    const channel = this.channel;
    if (!(this.ws?.readyState === (globalThis.WebSocket as typeof WebSocket).OPEN && channel?.ready)) {
      if (msg.t === "ping" || msg.t === "hello") return Promise.resolve();
      if (this.outbox.length < 50) this.outbox.push(msg);
      return Promise.resolve();
    }
    const next = this.sendChain.then(async () => {
      const frame = await channel.wrap(encode(msg));
      this.ws?.send(frame);
    });
    this.sendChain = next.catch(() => {});
    return next;
  }

  private async flush(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== (globalThis.WebSocket as typeof WebSocket).OPEN) return;
    for (const msg of this.outbox.splice(0)) {
      await this.send(msg);
    }
    this.openCbs.forEach((cb) => cb());
  }

  private queueHello(): void {
    this.outbox.unshift({
      t: "hello",
      name: this.opts.name,
      protocol: PROTOCOL_VERSION,
      ...(this.opts.observer ? { observer: true } : {}),
    });
  }

  close(): void {
    this.ws?.close(1000, "bye");
    this.ws = null;
  }
}
