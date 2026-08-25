/**
 * Work out where to connect and which token to use, from whatever someone
 * pastes: the share link from chat, a raw WebSocket URL, or a bare host:port.
 *
 * The token comes back separately and is never put into the URL. It is the
 * room's encryption key, so putting it on the wire would defeat the point —
 * a relay, a proxy or an access log would capture it.
 */
export interface JoinTarget {
  /** The WebSocket URL to dial. Carries no secret. */
  url: string;
  /** The room name, which keys the encryption alongside the token. */
  room: string;
  /** The room token, or null for an open room. */
  token: string | null;
  /** True when the URL is plain ws:// rather than wss://. */
  plaintext: boolean;
}

export function parseJoinTarget(target: string): JoinTarget {
  let t = target.trim().replace(/^["'<]|[">']$/g, "");
  if (!/^[a-z]+:\/\//.test(t)) t = "ws://" + t;

  const secure = t.startsWith("https://") || t.startsWith("wss://");
  const scheme = secure ? "wss://" : "ws://";
  const rest = t.slice(t.indexOf("://") + 3);

  const hashAt = rest.indexOf("#");
  const frag = hashAt >= 0 ? rest.slice(hashAt + 1) : "";
  const beforeHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const qAt = beforeHash.indexOf("?");
  const query = qAt >= 0 ? beforeHash.slice(qAt + 1) : "";
  const path = qAt >= 0 ? beforeHash.slice(0, qAt) : beforeHash;

  // Accept `?t=` from an older link for convenience, but never emit one.
  const token =
    new URLSearchParams(frag).get("t") ?? new URLSearchParams(query).get("t") ?? null;

  const slash = path.indexOf("/");
  const host = slash >= 0 ? path.slice(0, slash) : path;
  const rel = slash >= 0 ? path.slice(slash) : "";
  const room = /^\/[sr]\/(.+)$/.exec(rel)?.[1] ?? "";

  return {
    url: `${scheme}${host}${room ? `/r/${room}` : "/"}`,
    room: decodeURIComponent(room),
    token,
    plaintext: !secure,
  };
}

/** Hosts where plain ws:// is fine because the traffic never leaves the machine or LAN. */
export function isLocalHost(url: string): boolean {
  const host = (/^[a-z]+:\/\/([^/:]+)/.exec(url)?.[1] ?? "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}
