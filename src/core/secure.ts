import {
  deriveSessionKey,
  handshakeMac,
  macMatches,
  newEphemeral,
  open,
  randomNonce,
  seal,
  type Ephemeral,
  type RoomKey,
} from "./crypto.js";
import { SeqCounter, SeqGuard } from "./crypto.js";

/**
 * One end of an encrypted link, shared by the host and every seat.
 *
 * A connection begins with an ephemeral ECDH exchange authenticated by the room
 * token, and everything after it is sealed with the key that exchange produced.
 * The token proves who may join; it never encrypts anything. That separation is
 * what buys forward secrecy: the private halves live only in memory for the
 * life of the connection, so traffic recorded today stays unreadable even if
 * the link leaks tomorrow.
 *
 * Framing is deliberately dumb. Handshake frames are JSON and start with `{`;
 * data frames are base64 and never do.
 */
export type Role = "client" | "server";

export interface HandshakeStep {
  /** A frame to send back, if this step produces one. */
  reply?: string;
  /** True once both sides hold the session key. */
  ready: boolean;
  /** False means the frame did not authenticate — drop the connection. */
  ok: boolean;
}

export class SecureChannel {
  private out = new SeqCounter();
  private seen = new SeqGuard();
  private session: RoomKey | null = null;
  private mine: Ephemeral | null = null;
  private myNonce: Buffer | null = null;

  constructor(
    private authKey: Buffer | null,
    private room: string,
    private role: Role,
  ) {}

  /** True when this channel encrypts at all (a room with no token does not). */
  get encrypted(): boolean {
    return this.authKey !== null;
  }

  /** True once a session key exists and traffic can flow. */
  get ready(): boolean {
    return !this.encrypted || this.session !== null;
  }

  static isHandshake(frame: string): boolean {
    return frame.startsWith("{");
  }

  /** Client only: the opening frame. */
  begin(): string | null {
    if (!this.authKey || this.role !== "client") return null;
    this.mine = newEphemeral();
    this.myNonce = randomNonce();
    const mac = handshakeMac(this.authKey, "mpx-client", this.mine.pub, this.myNonce);
    return JSON.stringify({
      h: 2,
      epk: this.mine.pub.toString("base64"),
      n: this.myNonce.toString("base64"),
      mac: mac.toString("base64"),
    });
  }

  /** Consume a handshake frame from the other side. */
  handshake(frame: string): HandshakeStep {
    if (!this.authKey) return { ready: true, ok: true };
    let msg: { h?: number; epk?: string; n?: string; mac?: string };
    try {
      msg = JSON.parse(frame);
    } catch {
      return { ready: false, ok: false };
    }
    if (msg.h !== 2 || !msg.epk || !msg.n || !msg.mac) return { ready: false, ok: false };

    const peerPub = Buffer.from(msg.epk, "base64");
    const peerNonce = Buffer.from(msg.n, "base64");
    const claimed = Buffer.from(msg.mac, "base64");
    // A P-256 point is 65 bytes uncompressed; anything else is not one.
    if (peerPub.length !== 65 || peerPub[0] !== 0x04 || peerNonce.length !== 16) {
      return { ready: false, ok: false };
    }

    if (this.role === "server") {
      if (!macMatches(claimed, handshakeMac(this.authKey, "mpx-client", peerPub, peerNonce))) {
        return { ready: false, ok: false };
      }
      this.mine = newEphemeral();
      this.myNonce = randomNonce();
      let shared: Buffer;
      try {
        shared = this.mine.computeSecret(peerPub);
      } catch {
        // A point off the curve lands here rather than becoming a weak key.
        return { ready: false, ok: false };
      }
      this.session = deriveSessionKey(shared, peerNonce, this.myNonce, this.room);
      const mac = handshakeMac(this.authKey, "mpx-server", this.mine.pub, this.myNonce, peerPub, peerNonce);
      return {
        reply: JSON.stringify({
          h: 2,
          epk: this.mine.pub.toString("base64"),
          n: this.myNonce.toString("base64"),
          mac: mac.toString("base64"),
        }),
        ready: true,
        ok: true,
      };
    }

    if (!this.mine || !this.myNonce) return { ready: false, ok: false };
    // The server's MAC covers our half too, so a relay cannot splice a reply
    // from one handshake onto another.
    if (!macMatches(claimed, handshakeMac(this.authKey, "mpx-server", peerPub, peerNonce, this.mine.pub, this.myNonce))) {
      return { ready: false, ok: false };
    }
    let shared: Buffer;
    try {
      shared = this.mine.computeSecret(peerPub);
    } catch {
      return { ready: false, ok: false };
    }
    this.session = deriveSessionKey(shared, this.myNonce, peerNonce, this.room);
    return { ready: true, ok: true };
  }

  wrap(plaintext: string): string {
    if (!this.session) return plaintext;
    return seal(this.session, this.out.next(), plaintext);
  }

  /**
   * Returns the plaintext, or null for a frame that is forged, tampered with,
   * replayed, or sealed with a different key. Callers treat null as "this did
   * not come from the room" — there is no partial trust.
   */
  unwrap(frame: string): string | null {
    if (!this.session) return this.encrypted ? null : frame;
    const got = open(this.session, frame);
    if (!got) return null;
    if (!this.seen.accept(got.seq)) return null;
    return got.text;
  }

  /** Forget the agreed key. The ephemeral halves go with it. */
  reset(): void {
    this.session = null;
    this.mine = null;
    this.myNonce = null;
    this.out = new SeqCounter();
    this.seen = new SeqGuard();
  }
}
