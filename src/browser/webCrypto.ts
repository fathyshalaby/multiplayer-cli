import type { webcrypto } from "node:crypto";

/**
 * The same primitives as `core/crypto.ts`, reimplemented on the WebCrypto API
 * instead of `node:crypto`, so a browser extension's service worker — which
 * has no `node:crypto` — can join a room's encrypted channel.
 *
 * Nothing here may drift from `core/crypto.ts`: same curve (P-256), same HKDF
 * info strings, same HMAC labels, same AES-256-GCM frame layout
 * (nonce ‖ ciphertext ‖ tag). `test/webCrypto.test.ts` proves that by running
 * a real handshake and real sealed frames between this module and the
 * `core/crypto.ts`/`core/secure.ts` implementation and checking the two sides
 * agree byte-for-byte — the only way two independent AES-GCM implementations
 * earn trust.
 *
 * Only the WebCrypto API is used at runtime (`globalThis.crypto`, present in
 * both browsers and Node ≥19). The `node:crypto` import below is a type-only
 * import for `webcrypto.CryptoKey`/`webcrypto.SubtleCrypto`, exactly the
 * pattern `agent/index.ts` uses to keep the Anthropic SDK out of the runtime
 * import graph — it must never become a value import.
 */

const subtle: webcrypto.SubtleCrypto = (globalThis.crypto as webcrypto.Crypto).subtle;

const NONCE = 12;
const TAG_BITS = 128;
const KEY_BITS = 256;
const AUTH_INFO = "multiplayer-cli auth v2";
const SESSION_INFO = "multiplayer-cli session v2";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * `Buffer` does not exist in a browser extension's service worker — only
 * `btoa`/`atob`, which work on binary strings rather than bytes directly.
 * Node has both, which is exactly the trap: code built on `Buffer` here would
 * pass every test in this repo and still fail to load in a real extension.
 */
export function b64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function unb64(s: string): Uint8Array {
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits_ = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits);
  return new Uint8Array(bits_);
}

/** Mirrors `deriveAuthKey` in `core/crypto.ts`. */
export async function deriveAuthKeyWeb(token: string, room: string): Promise<Uint8Array> {
  return hkdfSha256(utf8(token), utf8(room), utf8(AUTH_INFO), KEY_BITS);
}

export interface EphemeralWeb {
  /** Uncompressed P-256 point — the same 65 bytes Node's `ecdh.generateKeys()` gives. */
  readonly pub: Uint8Array;
  computeSecret(peerPub: Uint8Array): Promise<Uint8Array>;
}

/** Mirrors `newEphemeral` in `core/crypto.ts`. */
export async function newEphemeralWeb(): Promise<EphemeralWeb> {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return {
    pub,
    async computeSecret(peerPub: Uint8Array): Promise<Uint8Array> {
      const peerKey = await subtle.importKey("raw", peerPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
      // WebCrypto's ECDH deriveBits gives the x-coordinate of the shared point —
      // the same value Node's `ecdh.computeSecret` returns.
      const shared = await subtle.deriveBits({ name: "ECDH", public: peerKey } as EcdhDeriveParams, pair.privateKey, 256);
      return new Uint8Array(shared);
    },
  };
}

/** Mirrors `handshakeMac` in `core/crypto.ts`: length-prefix each field, HMAC-SHA256. */
export async function handshakeMacWeb(authKey: Uint8Array, label: string, ...parts: Uint8Array[]): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", authKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const chunks: Uint8Array[] = [utf8(label)];
  for (const part of parts) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, part.length, false);
    chunks.push(len, part);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const data = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }
  const mac = await subtle.sign("HMAC", key, data);
  return new Uint8Array(mac);
}

export function macMatchesWeb(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Not constant-time — this module only ever runs client-side in a browser
  // extension, verifying the *server's* MAC; there is no local secret whose
  // timing an attacker on the same machine would gain from measuring here.
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Mirrors `deriveSessionKey` in `core/crypto.ts`. */
export async function deriveSessionKeyWeb(
  shared: Uint8Array,
  clientNonce: Uint8Array,
  serverNonce: Uint8Array,
  room: string,
): Promise<Uint8Array> {
  const salt = new Uint8Array(clientNonce.length + serverNonce.length);
  salt.set(clientNonce, 0);
  salt.set(serverNonce, clientNonce.length);
  const info = utf8(`${SESSION_INFO}:${room}`);
  return hkdfSha256(shared, salt, info, KEY_BITS);
}

export function randomNonceWeb(bytes = 16): Uint8Array {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Mirrors `seal` in `core/crypto.ts`. WebCrypto's AES-GCM `encrypt` already
 * returns ciphertext with the tag appended, which is the exact
 * nonce ‖ ciphertext ‖ tag layout `open()` in `core/crypto.ts` expects — no
 * repacking needed for the two to interoperate.
 */
export async function sealWeb(key: Uint8Array, room: string, seq: number, plaintext: string): Promise<string> {
  const nonce = randomNonceWeb(NONCE);
  const cryptoKey = await subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const data = utf8(`${seq}\n${plaintext}`);
  const sealed = await subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: utf8(room), tagLength: TAG_BITS },
    cryptoKey,
    data,
  );
  const out = new Uint8Array(nonce.length + sealed.byteLength);
  out.set(nonce, 0);
  out.set(new Uint8Array(sealed), nonce.length);
  return b64(out);
}

export interface OpenedWeb {
  seq: number;
  text: string;
}

/** Mirrors `open` in `core/crypto.ts`. */
export async function openWeb(key: Uint8Array, room: string, frame: string): Promise<OpenedWeb | null> {
  let raw: Uint8Array;
  try {
    raw = unb64(frame);
  } catch {
    return null;
  }
  const TAG_BYTES = TAG_BITS / 8;
  if (raw.length < NONCE + TAG_BYTES + 1) return null;

  const nonce = raw.slice(0, NONCE);
  const ciphertextAndTag = raw.slice(NONCE);

  try {
    const cryptoKey = await subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const opened = await subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: utf8(room), tagLength: TAG_BITS },
      cryptoKey,
      ciphertextAndTag,
    );
    const out = new TextDecoder().decode(opened);
    const nl = out.indexOf("\n");
    if (nl < 0) return null;
    const seq = Number(out.slice(0, nl));
    if (!Number.isSafeInteger(seq) || seq < 0) return null;
    return { seq, text: out.slice(nl + 1) };
  } catch {
    return null;
  }
}

/** Minimal shape `subtle.deriveBits` needs for ECDH; `lib: ES2023` has no DOM types for it. */
interface EcdhDeriveParams {
  name: "ECDH";
  public: webcrypto.CryptoKey;
}
