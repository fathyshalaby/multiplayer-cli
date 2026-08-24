// tsc does not copy assets; the browser seat is served from disk at runtime.
import { cp, mkdir } from "node:fs/promises";
await mkdir("dist/src/client/web", { recursive: true });
await cp("src/client/web", "dist/src/client/web", { recursive: true });
