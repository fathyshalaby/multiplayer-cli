import { WebConnection } from "../../src/browser/webConnection.js";
import { RunnerSeat } from "../../src/browser/runnerSeat.js";
import { TabSiteDriver } from "./tabSiteDriver.js";

/**
 * The service worker: holds the room connection and one `RunnerSeat` per
 * connected site tab. Everything it calls — `WebConnection`, `RunnerSeat` —
 * is proven end-to-end against a real `RoomServer` in
 * `test/runnerSeat.test.ts` and `test/webSecure.test.ts`; what is not proven
 * is this file itself, since nothing in this repository can load an
 * unpacked extension and drive it. Kept deliberately thin for that reason —
 * the risk should live in the tested modules, not here.
 */
export interface RoomSettings {
  /** ws:// or wss:// URL, including the room's path (e.g. `.../r/<room>`). */
  roomUrl: string;
  roomName: string;
  roomToken: string | null;
  seatName: string;
  /** Shown to the room as this runner's backend label, e.g. `chatgpt-web`. */
  backendLabel: string;
}

async function loadSettings(): Promise<RoomSettings | null> {
  const stored = (await chrome.storage.local.get(["roomUrl", "roomName", "roomToken", "seatName", "backendLabel"])) as Record<
    string,
    string | undefined
  >;
  if (!stored.roomUrl || !stored.roomName || !stored.seatName) return null;
  return {
    roomUrl: stored.roomUrl,
    roomName: stored.roomName,
    roomToken: stored.roomToken ?? null,
    seatName: stored.seatName,
    backendLabel: stored.backendLabel || "browser",
  };
}

async function startSeat(port: chrome.runtime.Port): Promise<void> {
  const settings = await loadSettings();
  if (!settings) {
    port.postMessage({ type: "notConfigured" });
    return;
  }

  const conn = new WebConnection({
    url: settings.roomUrl,
    room: settings.roomName,
    name: settings.seatName,
    token: settings.roomToken,
  });
  const site = new TabSiteDriver(port);
  const seat = new RunnerSeat(conn, settings.backendLabel, site, (text) => {
    port.postMessage({ type: "notice", text });
  });

  conn.on("message", (msg) => seat.handle(msg));
  conn.on("warn", (text) => port.postMessage({ type: "notice", text: `room connection warning: ${text}` }));
  conn.on("open", () => seat.offer());
  conn.on("closed", (why) => {
    port.postMessage({ type: "notice", text: `disconnected from the room: ${why}` });
  });

  port.onDisconnect.addListener(() => {
    seat.withdraw();
    conn.close();
  });

  await conn.connect();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "mpx-site") return;
  void startSeat(port);
});
