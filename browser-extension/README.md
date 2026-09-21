# mpx browser runner (experimental, unshipped)

Offers a ChatGPT (or, once configured, another chat site's) tab and whatever
subscription is signed into it to an mpx room, the same way a terminal seat
offers its own logged-in coding CLI with `--runner`. The room pools it exactly
like any other account: a room started with `--pool` can hand a turn to this
tab, and hand it right back if that tab's own account runs out
(`src/agent/limits.ts`, `src/browser/webRunner.ts`).

**Status: not a shipped extension.** Everything up through the room protocol —
`WebConnection`, `RunnerSeat`, `DomSiteDriver` — is proven against real code:
`test/runnerSeat.test.ts` runs a real `RoomServer` end to end, and
`test/browserExtension.test.ts` runs `DomSiteDriver` against a real page in a
real Chromium. `background.ts`, `content/index.ts`, and the selectors in
`src/content/sites.ts` are not — there is no way to load an unpacked extension
or drive a real ChatGPT/Claude.ai/Gemini session from this environment, and
every selector in `sites.ts` is a best-effort reading of that site's markup,
not a confirmed one. Whoever picks this up needs to:

1. `npm run build:browser-extension`, load `browser-extension/dist/` as an
   unpacked extension (`chrome://extensions` → Developer mode → Load unpacked).
2. Open the extension's options page and fill in the room's WebSocket URL,
   name, and token (the same values a terminal seat's join link carries), and
   a name for this seat.
3. Open a matching tab (`chatgpt.com`, `claude.ai`, or `gemini.google.com`)
   and confirm the selectors for that site in `src/content/sites.ts` actually
   match the live page — they were written without one, and will need
   correcting. Do this per site: getting ChatGPT's selectors right proves
   nothing about Claude.ai's or Gemini's, since each is guessed independently
   from that site's own markup.
4. Start a room with `mpx share --pool`, send a message, and watch whether the
   turn reaches this tab and streams back — `content/index.ts`'s console (via
   the tab's devtools) and the background worker's own console
   (`chrome://extensions` → service worker → "Inspect") are the two places to
   look when it doesn't.

Adding another site later means one more entry in `sites.ts` plus its match
pattern in `manifest.json`'s `content_scripts.matches` and
`host_permissions` — `DomSiteDriver` itself doesn't change, the same way
adding a coding CLI means a new `CliProfile` in `src/agent/profiles.ts`, not
a new class.

## Layout

| Path | What it does |
|---|---|
| `src/content/domSiteDriver.ts` | Drives a chat site's DOM: types into the compose box, watches it render, notices a capacity banner. Proven against a fixture page — see `test/browserExtension.test.ts`. |
| `src/content/sites.ts` | One selector config per site. Unverified — see above. |
| `src/content/index.ts` | The content script: wires `DomSiteDriver` to a `chrome.runtime` port. |
| `src/tabSiteDriver.ts` | The background worker's half of that port — implements `SiteDriver` by messaging the tab. |
| `src/background.ts` | Holds the room connection (`WebConnection`) and the seat (`RunnerSeat`), both from `src/browser/`. |
| `src/options.html` / `src/options.ts` | Where the room URL/token/name are entered, saved to `chrome.storage.local`. |

`src/browser/*.ts` — `WebConnection`, `WebSecureChannel`, `RunnerSeat`,
`finishBrowserTurn` — lives in the main package, not here, because it has no
DOM dependency and is tested under plain `node --test`. This extension is
mostly wiring around it.
