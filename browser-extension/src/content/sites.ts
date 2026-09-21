import type { SiteConfig } from "./domSiteDriver.js";

/**
 * One entry per supported site, the browser-extension equivalent of one
 * `CliProfile` per coding CLI in `src/agent/profiles.ts`.
 *
 * Unlike a CLI, a chat site documents no stable interface — these selectors
 * are a best-effort reading of the site's markup, not a confirmed one, and
 * will drift the way any scraped selector does. Whoever turns this on for a
 * given site should open it, verify each selector against the live page,
 * and correct this entry before trusting it — the same way `profiles.ts`'s
 * own comment insists a profile be checked against what a tool actually
 * documents, except here there is no document to check it against.
 */
export const SITES: Record<string, SiteConfig> = {
  "chatgpt.com": {
    name: "chatgpt",
    composeSelector: "#prompt-textarea",
    sendSelector: "[data-testid='send-button']",
    stopSelector: "[data-testid='stop-button']",
    responseSelector: "[data-message-author-role='assistant']:last-of-type",
    watchRootSelector: "main",
  },
  "claude.ai": {
    name: "claude",
    composeSelector: "div[contenteditable='true'].ProseMirror",
    sendSelector: "button[aria-label='Send message']",
    stopSelector: "button[aria-label='Stop response']",
    responseSelector: "[data-testid='chat-message']:last-of-type, .font-claude-message:last-of-type",
    watchRootSelector: "main",
  },
  "gemini.google.com": {
    name: "gemini",
    composeSelector: "div.ql-editor[contenteditable='true']",
    sendSelector: "button[aria-label='Send message']",
    stopSelector: "button[aria-label='Stop response']",
    responseSelector: "model-response:last-of-type",
    watchRootSelector: "chat-window, main",
  },
};

export function siteFor(hostname: string): SiteConfig | null {
  return SITES[hostname] ?? null;
}
