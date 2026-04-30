import { ApiDumpStore } from "./lib/apiDump.js";
import { LruCache } from "./lib/cache.js";
import { HttpClient } from "./lib/http.js";
import { createLogger } from "./lib/logger.js";
export function createContext(config) {
    const logger = createLogger(config.RDFM_LOG_LEVEL);
    const textCache = new LruCache({
        ttlMs: config.RDFM_CACHE_TTL_MS,
        max: config.RDFM_CACHE_MAX,
    });
    const http = new HttpClient({ config, logger, textCache });
    const apiDump = new ApiDumpStore(http, config, logger);
    return { config, logger, http, apiDump, textCache };
}
//# sourceMappingURL=context.js.map