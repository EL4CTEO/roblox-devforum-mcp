import type { Config } from "../config.js";
import type { ApiDump } from "../types.js";
import type { HttpClient } from "./http.js";
import type { Logger } from "./logger.js";
export declare class ApiDumpStore {
    private readonly http;
    private readonly cfg;
    private readonly logger;
    private cache;
    private fetchedAt;
    private inflight;
    constructor(http: HttpClient, cfg: Config, logger: Logger);
    isStale(): boolean;
    load(): Promise<ApiDump>;
    private fetch;
}
