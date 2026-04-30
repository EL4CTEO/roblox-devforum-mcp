import { URLS } from "../config.js";
export class ApiDumpStore {
    http;
    cfg;
    logger;
    cache = null;
    fetchedAt = 0;
    inflight = null;
    constructor(http, cfg, logger) {
        this.http = http;
        this.cfg = cfg;
        this.logger = logger;
    }
    isStale() {
        return !this.cache || Date.now() - this.fetchedAt > this.cfg.RDFM_API_DUMP_TTL_MS;
    }
    async load() {
        if (this.cache && !this.isStale())
            return this.cache;
        if (this.inflight)
            return this.inflight;
        this.inflight = this.fetch().finally(() => {
            this.inflight = null;
        });
        return this.inflight;
    }
    async fetch() {
        try {
            this.logger.debug("Fetching Full-API-Dump", { url: URLS.apiDump });
            const data = await this.http.getJson(URLS.apiDump, {
                etag: true,
            });
            this.cache = data;
            this.fetchedAt = Date.now();
            this.logger.info("API Dump loaded", {
                classes: data.Classes.length,
                enums: data.Enums.length,
            });
            return data;
        }
        catch (e) {
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
//# sourceMappingURL=apiDump.js.map