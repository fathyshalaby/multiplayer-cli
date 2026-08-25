import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Config {
  /** Display name, so nobody types `--name` twice. */
  name?: string;
  /** A relay to use by default, so `mpx share` stays one word. */
  relay?: string;
}

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "multiplayer-cli", "config.json");
}

export function readConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return raw && typeof raw === "object" ? (raw as Config) : {};
  } catch {
    return {};
  }
}

/** Merge and persist. A read-only home is not worth failing a session over. */
export function saveConfig(patch: Config): void {
  try {
    const path = configPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...readConfig(), ...patch }, null, 2));
  } catch {
    /* ignore */
  }
}

export function defaultName(): string {
  return readConfig().name || process.env.USER || process.env.USERNAME || "anon";
}
