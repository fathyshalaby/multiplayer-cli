import { type RoomKey, SeqCounter, SeqGuard, open, seal } from "./crypto.js";

/**
 * The two ends of an encrypted link, shared by the host and every seat.
 *
 * Framing is deliberately dumb: seal on the way out, open on the way in, drop
 * anything that does not authenticate. Nothing above this layer knows the
 * difference, which is why the room, the relay and the UI needed no changes to
 * gain end-to-end encryption.
 */
export class SecureChannel {
  private out = new SeqCounter();
  private seen = new SeqGuard();

  constructor(private rk: RoomKey | null) {}

  /** True when this channel actually encrypts (a room with no token does not). */
  get encrypted(): boolean {
    return this.rk !== null;
  }

  wrap(plaintext: string): string {
    if (!this.rk) return plaintext;
    return seal(this.rk, this.out.next(), plaintext);
  }

  /**
   * Returns the plaintext, or null for a frame that is forged, tampered with,
   * replayed, or sealed with a different token. Callers treat null as "this did
   * not come from the room" — there is no partial trust.
   */
  unwrap(frame: string): string | null {
    if (!this.rk) return frame;
    const got = open(this.rk, frame);
    if (!got) return null;
    if (!this.seen.accept(got.seq)) return null;
    return got.text;
  }
}
