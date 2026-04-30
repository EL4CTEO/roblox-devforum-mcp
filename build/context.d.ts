import type { Config } from "./config.js";
import { ApiDumpStore } from "./lib/apiDump.js";
import { LruCache } from "./lib/cache.js";
import { HttpClient } from "./lib/http.js";
import type { Logger } from "./lib/logger.js";
export interface AppContext {
    config: Config;
    logger: Logger;
    http: HttpClient;
    apiDump: ApiDumpStore;
    textCache: LruCache<string>;
}
export declare function createContext(config: Config): AppContext;
