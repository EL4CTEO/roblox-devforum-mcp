import type { Config } from "./config.js";
import { ApiDumpStore } from "./lib/apiDump.js";
import { LruCache } from "./lib/cache.js";
import { HttpClient } from "./lib/http.js";
import type { Logger } from "./lib/logger.js";
import { createLogger } from "./lib/logger.js";

export interface AppContext {
  config: Config;
  logger: Logger;
  http: HttpClient;
  apiDump: ApiDumpStore;
  textCache: LruCache<string>;
}

export function createContext(config: Config): AppContext {
  const logger = createLogger(config.RDFM_LOG_LEVEL);
  const textCache = new LruCache<string>({
    ttlMs: config.RDFM_CACHE_TTL_MS,
    max: config.RDFM_CACHE_MAX,
  });
  const http = new HttpClient({ config, logger, textCache });
  const apiDump = new ApiDumpStore(http, config, logger);
  return { config, logger, http, apiDump, textCache };
}
