import type { Config } from "../config.js";
import { URLS } from "../config.js";
import type { ApiDump } from "../types.js";
import type { HttpClient } from "./http.js";
import type { Logger } from "./logger.js";

export class ApiDumpStore {
  private cache: ApiDump | null = null;
  private fetchedAt = 0;
  private inflight: Promise<ApiDump> | null = null;

  constructor(
    private readonly http: HttpClient,
    private readonly cfg: Config,
    private readonly logger: Logger
  ) {}

  isStale(): boolean {
    return !this.cache || Date.now() - this.fetchedAt > this.cfg.RDFM_API_DUMP_TTL_MS;
  }

  async load(): Promise<ApiDump> {
    if (this.cache && !this.isStale()) return this.cache;
    if (this.inflight) return this.inflight;

    this.inflight = this.fetch().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetch(): Promise<ApiDump> {
    try {
      this.logger.debug("Fetching Full-API-Dump", { url: URLS.apiDump });
      const data = await this.http.getJson<ApiDump>(URLS.apiDump, {
        etag: true,
      });
      this.cache = data;
      this.fetchedAt = Date.now();
      this.logger.info("API Dump loaded", {
        classes: data.Classes.length,
        enums: data.Enums.length,
      });
      return data;
    } catch (e) {
      if (this.cache) {
        this.logger.warning("API Dump refresh failed; using stale", {
          error: e instanceof Error ? e.message : String(e),
        });
        return this.cache;
      }
      throw e;
    }
  }
}
