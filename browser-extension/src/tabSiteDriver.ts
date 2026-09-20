import type { SiteDriver } from "../../src/browser/runnerSeat.js";

/**
 * The background service worker's half of the bridge to a content script.
 * `RunnerSeat` (`src/browser/runnerSeat.ts`, already proven end-to-end
 * against a real room) only knows the `SiteDriver` interface — it has no
 * idea its calls are crossing an extension message port to a tab rather
 * than touching a page directly.
 *
 * The content script (`content/index.ts`) is the other half: it holds the
 * real `DomSiteDriver` and mirrors this same wire shape over the port. This
 * file has no DOM dependency and could in principle be unit-tested with a
 * fake `chrome.runtime.Port`, but the message shape it depends on is only
 * real once paired with a real content script in a real tab — unlike
 * `DomSiteDriver`, nothing here is provable without the extension actually
 * running, so this is unexecuted code, not just untested code.
 */
export class TabSiteDriver implements SiteDriver {
  private observerCb: ((text: string, generating: boolean) => void) | null = null;
  private lastBanner: string | null = null;
  private pendingSend: { resolve(): void; reject(err: Error): void } | null = null;

  constructor(private port: chrome.runtime.Port) {
    port.onMessage.addListener((msg: any) => this.onMessage(msg));
  }

  private onMessage(msg: any): void {
    if (msg?.type === "observation") {
      this.observerCb?.(msg.text ?? "", !!msg.generating);
    } else if (msg?.type === "banner") {
      this.lastBanner = typeof msg.text === "string" && msg.text ? msg.text : null;
    } else if (msg?.type === "sendAck") {
      this.pendingSend?.resolve();
      this.pendingSend = null;
    } else if (msg?.type === "sendError") {
      this.pendingSend?.reject(new Error(msg.message ?? "the site tab reported an error"));
      this.pendingSend = null;
    }
  }

  send(prompt: string): Promise<void> {
    // Sending is the one call a turn cannot proceed without, so it alone
    // waits for the content script to confirm the click actually landed —
    // watch()/limitBanner() are read paths and tolerate a missed message
    // (the next mutation just reports the current truth again).
    return new Promise((resolve, reject) => {
      this.pendingSend = { resolve, reject };
      this.port.postMessage({ type: "send", prompt });
    });
  }

  watch(onObservation: (text: string, generating: boolean) => void): () => void {
    this.observerCb = onObservation;
    return () => {
      this.observerCb = null;
    };
  }

  limitBanner(): string | null {
    return this.lastBanner;
  }

  async cancel(): Promise<void> {
    this.port.postMessage({ type: "cancel" });
  }
}
