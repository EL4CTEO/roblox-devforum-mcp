import * as z from "zod";

export const VERSION = "5.0.0";

export const URLS = {
  devforum: "https://devforum.roblox.com",
  creatorDocs: "https://create.roblox.com/docs",
  robloxStatus: "https://status.roblox.com",
  creatorStore: "https://catalog.roblox.com",
  searchEngine: "https://duckduckgo.com/html",
  apiDump:
    "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json",
  luauLang: "https://luau-lang.org",
} as const;

export const COMMON_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

const EnvSchema = z.object({
  RDFM_LOG_LEVEL: z.enum(["debug", "info", "notice", "warning", "error"]).default("info"),
  RDFM_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  RDFM_CACHE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  RDFM_CACHE_MAX: z.coerce.number().int().positive().default(200),
  RDFM_API_DUMP_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  RDFM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  RDFM_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(1_000),
  RDFM_USER_AGENT: z.string().default(COMMON_HEADERS["User-Agent"] as string),
  RDFM_CIRCUIT_THRESHOLD: z.coerce.number().int().positive().default(5),
  RDFM_CIRCUIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RDFM_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
});

export type Config = z.infer<typeof EnvSchema>;

export type EnvLike = Record<string, unknown>;

function defaultEnv(): EnvLike {
  const proc = (globalThis as { process?: { env?: EnvLike } }).process;
  return proc?.env ?? {};
}

export function loadConfig(env: EnvLike = defaultEnv()): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const SERVER_NAME = "roblox-devforum-mcp";

export const CATEGORY_WEIGHTS: Record<number, number> = {
  6: 30,
  36: 20,
  35: 15,
};
