/**
 * Accept whatever someone pastes: the share link from chat, the raw WebSocket
 * URL, or a bare host:port. A link that was clickable in Slack should also work
 * when it is pasted into a terminal.
 */
export function normalizeJoinUrl(target: string): string {
  let t = target.trim().replace(/^["'<]|[">']$/g, "");
  if (!/^[a-z]+:\/\//.test(t)) t = "ws://" + t;

  const scheme = t.startsWith("https://") || t.startsWith("wss://") ? "wss://" : "ws://";
  const rest = t.slice(t.indexOf("://") + 3);
  const hashAt = rest.indexOf("#");
  const frag = hashAt >= 0 ? rest.slice(hashAt + 1) : "";
  const beforeHash = hashAt >= 0 ? rest.slice(0, hashAt) : rest;
  const qAt = beforeHash.indexOf("?");
  const query = qAt >= 0 ? beforeHash.slice(qAt + 1) : "";
  const path = qAt >= 0 ? beforeHash.slice(0, qAt) : beforeHash;

  // The share link carries the token in the fragment so browsers keep it off
  // the wire; a terminal has to move it back onto the query string.
  const token = new URLSearchParams(frag).get("t") ?? new URLSearchParams(query).get("t") ?? "";

  const slash = path.indexOf("/");
  const host = slash >= 0 ? path.slice(0, slash) : path;
  const rel = slash >= 0 ? path.slice(slash) : "";
  const room = /^\/s\/(.+)$/.exec(rel)?.[1];

  const target2 = room ? `/r/${room}` : rel === "/" ? "/" : rel;
  return `${scheme}${host}${target2}${token ? `?t=${token}` : ""}`;
}

