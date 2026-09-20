import type { SiteDriver } from "../../../src/browser/runnerSeat.js";

/**
 * What one chat site's page looks like, in CSS selector terms. This is the
 * only thing that differs between "ChatGPT" and "Claude.ai" and "Gemini" —
 * the driving mechanism below is the same for all of them, the same way one
 * `ProcessBackend` drives every CLI profile in `src/agent/profiles.ts`.
 *
 * Every selector here is a guess at each site's current markup, not a
 * confirmed one — there is no documented DOM the way a CLI documents its own
 * flags. `sites.ts` says so again next to each config. Whoever ships an
 * adapter for a given site needs to open it and confirm these against the
 * live page before trusting them.
 */
export interface SiteConfig {
  name: string;
  /** The message compose box — usually a `contenteditable` div on these sites, not a `<textarea>`. */
  composeSelector: string;
  sendSelector: string;
  /** The site's own "stop generating" control; its presence means the model is still streaming. */
  stopSelector: string;
  /** The most recent assistant message's container. */
  responseSelector: string;
  /** A capacity/limit banner, if the site shows one as its own element. */
  limitBannerSelector?: string;
  /** Narrows the MutationObserver's scope; falls back to the whole page. */
  watchRootSelector?: string;
}

/**
 * Implements `SiteDriver` (`src/browser/runnerSeat.ts`) against a real page,
 * given nothing but selectors. `RunnerSeat` never imports this — it only
 * knows the `SiteDriver` interface — so everything already proven about
 * turn-completion and delta streaming (`src/browser/streamTurn.ts`,
 * `test/streamTurn.test.ts`) applies unchanged to whatever this drives.
 *
 * `test/browserExtension.test.ts` runs this against a real Chromium page —
 * not ChatGPT, since there is no way to prove selectors against a live site
 * without an account and no way to make that reproducible in CI, but a local
 * fixture built to behave the way these sites' compose boxes actually do:
 * a controlled `contenteditable` element that only reacts to a real `input`
 * event, not a direct property assignment.
 */
export class DomSiteDriver implements SiteDriver {
  constructor(
    private config: SiteConfig,
    private doc: Document = document,
  ) {}

  async send(prompt: string): Promise<void> {
    const compose = this.doc.querySelector<HTMLElement>(this.config.composeSelector);
    if (!compose) {
      throw new Error(`${this.config.name}: compose box not found (${this.config.composeSelector})`);
    }
    setComposedValue(compose, prompt);
    // Give the page's own framework a tick to react to the input event and
    // enable its send control before we look for it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sendBtn = this.doc.querySelector<HTMLButtonElement>(this.config.sendSelector);
    if (!sendBtn || sendBtn.disabled) {
      throw new Error(`${this.config.name}: send control not available (${this.config.sendSelector})`);
    }
    sendBtn.click();
  }

  watch(onObservation: (text: string, generating: boolean) => void): () => void {
    const root = (this.config.watchRootSelector ? this.doc.querySelector(this.config.watchRootSelector) : null) ?? this.doc.body;
    const report = () => {
      const node = this.doc.querySelector(this.config.responseSelector);
      const generating = !!this.doc.querySelector(this.config.stopSelector);
      onObservation(node?.textContent ?? "", generating);
    };
    const observer = new MutationObserver(report);
    // `attributes: true` matters as much as the text-watching options: a site
    // that hides its stop control by toggling `hidden`/a class rather than
    // removing the element produces an attribute-only mutation with no
    // accompanying text change, and `stepTurn`'s completion detection depends
    // on `generating` going false — missing that mutation type means a
    // finished turn can look like it is generating forever. Caught by
    // `test/browserExtension.test.ts` against the fixture's own stop button.
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    report(); // the response node may already exist and be worth an initial read
    return () => observer.disconnect();
  }

  limitBanner(): string | null {
    if (!this.config.limitBannerSelector) return null;
    const node = this.doc.querySelector(this.config.limitBannerSelector);
    const text = node?.textContent?.trim();
    return text || null;
  }

  async cancel(): Promise<void> {
    const stopBtn = this.doc.querySelector<HTMLButtonElement>(this.config.stopSelector);
    stopBtn?.click();
  }
}

/**
 * React (and most frameworks built like it) tracks a form control's value
 * through the property setter its own synthetic input system overrides.
 * Assigning `.value` directly bypasses that setter, so the framework's state
 * never updates and the box silently reverts the moment it next renders —
 * the classic failure mode of scripting a React app from outside it. Going
 * through the native setter first, then dispatching `input`, is what makes
 * the site's own handler actually fire.
 *
 * ChatGPT's and Claude.ai's compose boxes are `contenteditable` elements
 * rather than `<textarea>`, which have no `value` property at all — for
 * those, setting `textContent` directly and dispatching `input` is the
 * closest equivalent, though `contenteditable` input handling varies more
 * across frameworks and is the more fragile of the two paths.
 */
function setComposedValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(el, value);
  } else {
    el.textContent = value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
