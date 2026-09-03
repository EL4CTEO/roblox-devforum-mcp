/** Best-effort disk cache, so a fresh process does not re-download large static files. */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = process.env.DEVFORUM_CACHE_DIR ?? join(tmpdir(), "roblox-devforum-mcp");

/**
 * Return the cached value for `name` when it is younger than `maxAgeMs`, otherwise run
 * `load` and cache its result. Every filesystem step is optional: if the cache cannot be
 * read or written the loader still runs and the value is still returned.
 */
export async function cachedJson<T>(name: string, maxAgeMs: number, load: () => Promise<T>): Promise<T> {
  const file = join(DIR, `${name}.json`);
  let stale: T | undefined;
  try {
    const info = await stat(file);
    const cached = JSON.parse(await readFile(file, "utf8")) as T;
    if (Date.now() - info.mtimeMs < maxAgeMs) return cached;
    stale = cached;
  } catch {
    /* missing or unreadable — fall through to the loader */
  }

  let value: T;
  try {
    value = await load();
  } catch (err) {
    // Yesterday's copy of the docs file tree or the API dump answers almost every question
    // today's would. Failing the whole tool because GitHub rate-limited one refresh trades a
    // slightly stale answer for no answer at all.
    if (stale !== undefined) {
      process.stderr.write(`[roblox-devforum-mcp] ${name} refresh failed, using the cached copy\n`);
      return stale;
    }
    throw err;
  }
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(file, JSON.stringify(value), "utf8");
  } catch {
    /* caching is an optimisation, never a requirement */
  }
  return value;
}
