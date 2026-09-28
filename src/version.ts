/** The package version, read from package.json rather than written out again in code. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The two spellings drifted: package.json said 1.2.7 while the handshake still announced
 * 1.2.6, so every client — and every bug report quoting one — named the wrong release. The
 * file sits next to dist/ in the published package and in the repo alike.
 */
function readVersion(): string {
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const { version } = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    if (typeof version === "string" && version) return version;
  } catch {
    /* a server that cannot read its own version still has a forum to search */
  }
  return "0.0.0";
}

export const VERSION = readVersion();
