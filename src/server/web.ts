import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

// Present when this module has been bundled to CommonJS; absent under ESM.
declare const __dirname: string | undefined;

/**
 * Where this module lives, tolerating being bundled.
 *
 * A bundler that emits CommonJS leaves `import.meta.url` undefined, and feeding
 * that to `fileURLToPath` throws at import time — which would take down
 * anything embedding this, such as the editor extension. Work it out lazily and
 * fall back rather than assuming an ESM file on disk.
 */
function moduleDir(): string {
  const url = (import.meta as { url?: string } | undefined)?.url;
  if (typeof url === "string" && url.startsWith("file:")) return dirname(fileURLToPath(url));
  if (typeof __dirname === "string") return __dirname;
  return process.cwd();
}

let cached: string | null = null;

/**
 * The browser seat, served by whatever is closest to the room — the host's own
 * listener for a direct room, the relay for a relayed one.
 *
 * It exists so a shared link is worth clicking. Someone who does not have node,
 * or does not want to install anything to weigh in on one decision, still gets
 * a real seat: they can read the session, propose, and vote.
 */
export function sessionPage(): string {
  if (cached) return cached;
  const here = moduleDir();
  const candidates = [
    // dist/src/server/ -> dist/src/client/web/
    join(here, "..", "client", "web", "session.html"),
    // bundled: copied next to the bundle
    join(here, "session.html"),
    join(here, "web", "session.html"),
  ];
  for (const path of candidates) {
    try {
      cached = readFileSync(path, "utf8");
      return cached;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    `could not find session.html (looked in ${candidates.join(", ")}) — the browser seat is missing from this build`,
  );
}

/** Serve the seat for `/s/<room>`; returns false if the path is not ours. */
export function serveWeb(pathname: string, res: ServerResponse): boolean {
  if (pathname !== "/s" && !pathname.startsWith("/s/")) return false;
  const body = sessionPage();
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // The page only ever talks to its own origin, and inlines everything.
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
  return true;
}

/**
 * The link a host pastes into chat.
 *
 * The token rides in the fragment, which browsers never send to a server, so
 * it stays out of relay access logs and proxy history. The page reads it back
 * and puts it on the WebSocket, where the host checks it as always.
 */
export function shareLink(httpBase: string, room: string, token: string | null): string {
  return `${httpBase}/s/${encodeURIComponent(room)}${token ? `#t=${token}` : ""}`;
}

/** ws:// or wss:// -> the http origin a browser would use. */
export function httpOrigin(wsBase: string): string {
  if (wsBase.startsWith("wss://")) return "https://" + wsBase.slice(6);
  if (wsBase.startsWith("ws://")) return "http://" + wsBase.slice(5);
  return wsBase;
}
