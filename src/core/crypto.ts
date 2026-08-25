import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * End-to-end encryption for room traffic.
 *
 * A room's token is not a password sent to a server — it is the key. Every
 * frame between a seat and the host is sealed with it, so anything in between
 * (a relay, a TLS terminator, a corporate proxy, whoever runs the box) moves
 * ciphertext it cannot read. The token itself never travels: a seat proves it
 * has one by producing a frame that decrypts, which means there is nothing on
 * the wire for an operator or a log to capture.
 *
 * AES-256-GCM with random nonces, keyed by HKDF over the token, with the room
 * name as associated data so a frame cannot be replayed into a different room.
 */

const NONCE = 12;
const TAG = 16;
const KEY = 32;
const INFO = "multiplayer-cli room v1";
const AUTH_INFO = "multiplayer-cli auth v2";
const SESSION_INFO = "multiplayer-cli session v2";
/** P-256, because every browser's WebCrypto has it and Node speaks it natively. */
const CURVE = "prime256v1";

export interface RoomKey {
  readonly key: Buffer;
  readonly room: string;
}

/**
 * Turn a room token into a key. The salt is the room name, so the same token
 * reused for two rooms yields two unrelated keys.
 *
 * Used for the transcript of a room with no handshake; live connections use a
 * session key from `deriveSessionKey` instead, so that the token is never the
 * thing protecting traffic.
 */
export function deriveKey(token: string, room: string): RoomKey {
  const bits = hkdfSync("sha256", Buffer.from(token, "utf8"), Buffer.from(room, "utf8"), Buffer.from(INFO, "utf8"), KEY);
  return { key: Buffer.from(bits), room };
}

/**
 * Seal one message. `seq` is carried inside the ciphertext so a relay cannot
 * reorder or replay frames without the receiver noticing.
 */
export function seal(rk: RoomKey, seq: number, plaintext: string): string {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", rk.key, nonce);
  cipher.setAAD(Buffer.from(rk.room, "utf8"));
  const body = Buffer.concat([cipher.update(`${seq}\n${plaintext}`, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64");
}

export interface Opened {
  seq: number;
  text: string;
}

/** Open a frame, returning null for anything that is not authentically ours. */
export function open(rk: RoomKey, frame: string): Opened | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(frame, "base64");
  } catch {
    return null;
  }
  if (raw.length < NONCE + TAG + 1) return null;

  const nonce = raw.subarray(0, NONCE);
  const tag = raw.subarray(raw.length - TAG);
  const body = raw.subarray(NONCE, raw.length - TAG);

  try {
    const decipher = createDecipheriv("aes-256-gcm", rk.key, nonce);
    decipher.setAAD(Buffer.from(rk.room, "utf8"));
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
    const nl = out.indexOf("\n");
    if (nl < 0) return null;
    const seq = Number(out.slice(0, nl));
    if (!Number.isSafeInteger(seq) || seq < 0) return null;
    return { seq, text: out.slice(nl + 1) };
  } catch {
    // A bad tag, a wrong key, or a tampered frame all land here, and all mean
    // the same thing to the caller: this did not come from the room.
    return null;
  }
}

/**
 * Per-connection replay guard.
 *
 * Frames must arrive in strictly increasing order. A relay that duplicates,
 * drops back to, or reorders frames is rejected rather than trusted, which is
 * the point of not trusting the relay.
 */
export class SeqGuard {
  private last = -1;
  accept(seq: number): boolean {
    if (seq <= this.last) return false;
    this.last = seq;
    return true;
  }
}

/** Monotonic counter for outgoing frames on one connection. */
export class SeqCounter {
  private n = 0;
  next(): number {
    return this.n++;
  }
}

/** Constant-time compare, for the few places a plain secret is still compared. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}


/* ------------------------------------------------------------------ */
/* forward secrecy                                                     */
/* ------------------------------------------------------------------ */

/**
 * The token proves membership; it does not encrypt anything.
 *
 * Deriving the traffic key straight from the token means one key for the life
 * of a room, so anyone who records traffic and later obtains the link can read
 * what they recorded. Instead each connection agrees a fresh key by ephemeral
 * ECDH, and the token only authenticates that exchange. The private halves
 * never leave memory and are gone when the connection ends, so recorded
 * traffic stays unreadable even if the link leaks afterwards.
 */
export function deriveAuthKey(token: string, room: string): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(token, "utf8"), Buffer.from(room, "utf8"), Buffer.from(AUTH_INFO, "utf8"), KEY),
  );
}

export interface Ephemeral {
  /** Uncompressed P-256 point, the same 65 bytes WebCrypto exports as "raw". */
  readonly pub: Buffer;
  /** The X coordinate of the shared point — what WebCrypto's deriveBits gives. */
  computeSecret(peerPub: Buffer): Buffer;
}

export function newEphemeral(): Ephemeral {
  const ecdh = createECDH(CURVE);
  const pub = ecdh.generateKeys();
  return {
    pub,
    computeSecret(peerPub: Buffer): Buffer {
      return ecdh.computeSecret(peerPub);
    },
  };
}

/** Authenticate one side of the handshake with the room token. */
export function handshakeMac(authKey: Buffer, label: string, ...parts: Buffer[]): Buffer {
  const mac = createHmac("sha256", authKey);
  mac.update(label);
  for (const part of parts) {
    // Length-prefix each field so two different splits cannot produce the same
    // input — the classic way a MAC over concatenation goes wrong.
    const len = Buffer.alloc(4);
    len.writeUInt32BE(part.length);
    mac.update(len);
    mac.update(part);
  }
  return mac.digest();
}

export function macMatches(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Mix the agreed point with both nonces, so neither side alone chooses the
 * key and a replayed handshake cannot resurrect an old one.
 */
export function deriveSessionKey(
  shared: Buffer,
  clientNonce: Buffer,
  serverNonce: Buffer,
  room: string,
): RoomKey {
  const salt = Buffer.concat([clientNonce, serverNonce]);
  const info = Buffer.from(`${SESSION_INFO}:${room}`, "utf8");
  return { key: Buffer.from(hkdfSync("sha256", shared, salt, info, KEY)), room };
}

export function randomNonce(bytes = 16): Buffer {
  return randomBytes(bytes);
}
