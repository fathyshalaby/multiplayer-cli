import {
  b64,
  unb64,
  deriveSessionKeyWeb,
  handshakeMacWeb,
  macMatchesWeb,
  newEphemeralWeb,
  openWeb,
  randomNonceWeb,
  sealWeb,
  type EphemeralWeb,
} from "./webCrypto.js";

/**
 * `core/secure.ts`'s `SecureChannel`, rebuilt on `webCrypto.ts` for a browser
 * extension's service worker. Same wire format, same public shape — `begin`,
 * `handshake`, `wrap`, `unwrap`, `reset` — just async, because every WebCrypto
 * operation underneath it is a promise. `test/webSecure.test.ts` runs this
 * class against a real `SecureChannel` instance, not just against itself.
 */
export type Role = "client" | "server";

export interface HandshakeStep {
  reply?: string;
  ready: boolean;
  ok: boolean;
}

/** Mirrors `SeqGuard` in `core/crypto.ts`: frames must arrive strictly increasing. */
class SeqGuardWeb {
  private last = -1;
  accept(seq: number): boolean {
    if (seq <= this.last) return false;
    this.last = seq;
    return true;
  }
}

/** Mirrors `SeqCounter` in `core/crypto.ts`. */
class SeqCounterWeb {
  private n = 0;
  next(): number {
    return this.n++;
  }
}

export class WebSecureChannel {
  private out = new SeqCounterWeb();
  private seen = new SeqGuardWeb();
  private session: Uint8Array | null = null;
  private mine: EphemeralWeb | null = null;
  private myNonce: Uint8Array | null = null;

  constructor(
    private authKey: Uint8Array | null,
    private room: string,
    private role: Role,
  ) {}

  get encrypted(): boolean {
    return this.authKey !== null;
  }

  get ready(): boolean {
    return !this.encrypted || this.session !== null;
  }

  static isHandshake(frame: string): boolean {
    return frame.startsWith("{");
  }

  /** Client only: the opening frame. */
  async begin(): Promise<string | null> {
    if (!this.authKey || this.role !== "client") return null;
    this.mine = await newEphemeralWeb();
    this.myNonce = randomNonceWeb();
    const mac = await handshakeMacWeb(this.authKey, "mpx-client", this.mine.pub, this.myNonce);
    return JSON.stringify({
      h: 2,
      epk: b64(this.mine.pub),
      n: b64(this.myNonce),
      mac: b64(mac),
    });
  }

  /** Consume a handshake frame from the other side. */
  async handshake(frame: string): Promise<HandshakeStep> {
    if (!this.authKey) return { ready: true, ok: true };
    let msg: { h?: number; epk?: string; n?: string; mac?: string };
    try {
      msg = JSON.parse(frame);
    } catch {
      return { ready: false, ok: false };
    }
    if (msg.h !== 2 || !msg.epk || !msg.n || !msg.mac) return { ready: false, ok: false };

    let peerPub: Uint8Array;
    let peerNonce: Uint8Array;
    let claimed: Uint8Array;
    try {
      peerPub = unb64(msg.epk);
      peerNonce = unb64(msg.n);
      claimed = unb64(msg.mac);
    } catch {
      return { ready: false, ok: false };
    }
    // A P-256 point is 65 bytes uncompressed; anything else is not one.
    if (peerPub.length !== 65 || peerPub[0] !== 0x04 || peerNonce.length !== 16) {
      return { ready: false, ok: false };
    }

    if (this.role === "server") {
      const expected = await handshakeMacWeb(this.authKey, "mpx-client", peerPub, peerNonce);
      if (!macMatchesWeb(claimed, expected)) return { ready: false, ok: false };

      this.mine = await newEphemeralWeb();
      this.myNonce = randomNonceWeb();
      let shared: Uint8Array;
      try {
        shared = await this.mine.computeSecret(peerPub);
      } catch {
        return { ready: false, ok: false };
      }
      this.session = await deriveSessionKeyWeb(shared, peerNonce, this.myNonce, this.room);
      const mac = await handshakeMacWeb(this.authKey, "mpx-server", this.mine.pub, this.myNonce, peerPub, peerNonce);
      return {
        reply: JSON.stringify({
          h: 2,
          epk: b64(this.mine.pub),
          n: b64(this.myNonce),
          mac: b64(mac),
        }),
        ready: true,
        ok: true,
      };
    }

    if (!this.mine || !this.myNonce) return { ready: false, ok: false };
    const expected = await handshakeMacWeb(this.authKey, "mpx-server", peerPub, peerNonce, this.mine.pub, this.myNonce);
    if (!macMatchesWeb(claimed, expected)) return { ready: false, ok: false };

    let shared: Uint8Array;
    try {
      shared = await this.mine.computeSecret(peerPub);
    } catch {
      return { ready: false, ok: false };
    }
    this.session = await deriveSessionKeyWeb(shared, this.myNonce, peerNonce, this.room);
    return { ready: true, ok: true };
  }

  async wrap(plaintext: string): Promise<string> {
    if (!this.session) return plaintext;
    return sealWeb(this.session, this.room, this.out.next(), plaintext);
  }

  /**
   * Returns the plaintext, or null for a frame that is forged, tampered with,
   * replayed, or sealed with a different key — same contract as
   * `SecureChannel.unwrap`: null means "this did not come from the room".
   */
  async unwrap(frame: string): Promise<string | null> {
    if (!this.session) return this.encrypted ? null : frame;
    const got = await openWeb(this.session, this.room, frame);
    if (!got) return null;
    if (!this.seen.accept(got.seq)) return null;
    return got.text;
  }

  reset(): void {
    this.session = null;
    this.mine = null;
    this.myNonce = null;
    this.out = new SeqCounterWeb();
    this.seen = new SeqGuardWeb();
  }
}
