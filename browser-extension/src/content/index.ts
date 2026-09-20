import { DomSiteDriver } from "./domSiteDriver.js";
import { siteFor } from "./sites.js";

/**
 * The content script: one per matching tab. Finds this site's config, drives
 * it with `DomSiteDriver` (proven against a real page in
 * `test/browserExtension.test.ts`), and mirrors it over a `chrome.runtime`
 * port to `TabSiteDriver` in the background worker — this file is the other,
 * unexecuted half of that bridge.
 *
 * Watching starts the moment this script loads, independent of whether a
 * turn is active: `TabSiteDriver.watch()` only forwards observations while
 * `RunnerSeat` has actually asked for them, so an observation posted between
 * turns is simply dropped there, and the alternative — telling the content
 * script to start/stop watching per turn — is a second thing that can go
 * out of sync with the port for no real benefit.
 */
const config = siteFor(location.hostname);
if (config) {
  const driver = new DomSiteDriver(config);
  const port = chrome.runtime.connect({ name: "mpx-site" });

  driver.watch((text, generating) => {
    port.postMessage({ type: "observation", text, generating });
    port.postMessage({ type: "banner", text: driver.limitBanner() });
  });

  port.onMessage.addListener((msg: any) => {
    if (msg?.type === "send") {
      driver
        .send(msg.prompt)
        .then(() => port.postMessage({ type: "sendAck" }))
        .catch((err: unknown) => port.postMessage({ type: "sendError", message: (err as Error)?.message ?? String(err) }));
    } else if (msg?.type === "cancel") {
      void driver.cancel();
    }
  });
}
