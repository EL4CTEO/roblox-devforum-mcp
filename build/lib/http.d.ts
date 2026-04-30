import type { Config } from "../config.js";
import { type LruCache } from "./cache.js";
import type { Logger } from "./logger.js";
export declare class HttpError extends Error {
    readonly status: number;
    readonly url: string;
    constructor(message: string, status: number, url: string);
}
export declare class CircuitOpenError extends Error {
    constructor(host: string);
}
export interface FetchOptions {
    json?: boolean;
    etag?: string | undefined;
    retries?: number | undefined;
    signal?: AbortSignal | undefined;
}
export interface HttpClientDeps {
    config: Config;
    logger: Logger;
    textCache: LruCache<string>;
    fetchImpl?: typeof fetch;
}
export declare class HttpClient {
    private readonly cfg;
    private readonly logger;
    private readonly cache;
    private readonly fetchImpl;
    private readonly breaker;
    constructor(deps: HttpClientDeps);
    private buildHeaders;
    raw(url: string, opts?: FetchOptions): Promise<Response>;
    private backoff;
    getJson<T>(url: string, opts?: {
        etag?: boolean;
        cache?: boolean;
    }): Promise<T>;
    getJsonWithFallback<T>(urls: string[]): Promise<T>;
    getHtml(url: string, opts?: {
        cache?: boolean;
    }): Promise<string>;
}
