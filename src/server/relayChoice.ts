/**
 * Which relay, if any, `mpx share` goes through.
 *
 * A link that only works on the host's own network is not much of a link: the
 * person most likely to be sent one is a teammate somewhere else. So `share`,
 * the no-configuration path, goes through a hosted relay unless told not to.
 * The relay only ever moves sealed frames (see `relay.ts`), so what it learns is
 * who is connected and how much they say, never what.
 *
 * This is a pure function, for the same reason `gate.ts` is: every rule below is
 * a decision someone will want to check, and each one is a unit test only
 * because nothing here reads the environment, the config file or the network
 * for itself. `cli.ts` gathers those and passes them in.
 */

/**
 * The relay `mpx share` uses when nobody has said otherwise.
 *
 * Fly's own hostname for the app `multiplayer-cloud` deploys, not a custom
 * domain. That is deliberate: a `*.fly.dev` address keeps resolving after a
 * custom domain is added, so every CLI ever shipped with this constant keeps
 * working when the hosted relay moves to a nicer name. If the Fly app is ever
 * renamed, change this, and `deploy/relay/fly.toml`'s `app` there, together.
 */
export const DEFAULT_RELAY = "wss://mpx-relay.fly.dev";

/** Values of `MPX_RELAY` that mean "no default relay", not a URL. */
const OFF = new Set(["off", "none", "no", "false", "0", "local", "lan"]);

export interface RelayChoiceInput {
  /** `--relay <url>`, empty when not given. */
  explicit: string;
  /** `share` (true) or `host`/`serve` (false), which only relay when asked. */
  easy: boolean;
  /** `--local`: this machine only. */
  local: boolean;
  /** `--lan`: the host's network, the way `share` behaved before 0.14. */
  lan: boolean;
  /** `--open`: no token, so nothing is encrypted. */
  open: boolean;
  /** A relay remembered from an earlier `--relay`. */
  saved: string | null | undefined;
  /** `MPX_RELAY`, a URL or one of the off words. */
  env: string | null | undefined;
  /** The built-in default, passed in so tests do not depend on the constant. */
  builtin: string;
}

export type RelaySource = "flag" | "saved" | "env" | "default";

export interface RelayChoice {
  url: string | null;
  /** Where `url` came from. Null when there is no relay. */
  source: RelaySource | null;
  /**
   * Why a relay that would otherwise have been used was not. Shown to the host,
   * so `--open` going LAN-only is a stated fact rather than a surprise.
   */
  note: string | null;
}

export function chooseRelay(input: RelayChoiceInput): RelayChoice {
  // Asked for by name always wins, on every command, as it always has. That
  // includes an open room: the person typing --relay chose where it goes.
  if (input.explicit) return { url: input.explicit, source: "flag", note: null };
  if (!input.easy) return { url: null, source: null, note: null };
  if (input.local || input.lan) return { url: null, source: null, note: null };

  // Flag, then environment, then the saved config, then the built-in: the
  // usual order, so `MPX_RELAY=off` in a CI job or a shell profile turns off
  // every relay nobody asked for on the command line, a remembered one too.
  const env = input.env?.trim() ?? "";
  let picked: { url: string; source: RelaySource } | null;
  if (OFF.has(env.toLowerCase())) picked = null;
  else if (env) picked = { url: env, source: "env" };
  else if (input.saved) picked = { url: input.saved, source: "saved" };
  else picked = { url: input.builtin, source: "default" };
  if (!picked) return { url: null, source: null, note: null };

  // Fail closed on plaintext. An open room has no key, so every frame would
  // reach a relay readable, and the host never named that relay. Keep it on
  // their network unless they ask for a relay explicitly.
  if (input.open) {
    return {
      url: null,
      source: null,
      note: "--open has no encryption, so it stays on your network — pass --relay <url> to send it through one anyway",
    };
  }
  return { url: picked.url, source: picked.source, note: null };
}
