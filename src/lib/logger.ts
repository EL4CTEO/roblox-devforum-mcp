import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type LogLevel = "debug" | "info" | "notice" | "warning" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
};

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  notice(msg: string, data?: Record<string, unknown>): void;
  warning(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  setLevel(level: LogLevel): void;
  setServer(server: McpServer): void;
}

class McpLogger implements Logger {
  private server: McpServer | undefined;
  private level: LogLevel;
  private readonly loggerName: string;

  constructor(level: LogLevel = "info", loggerName = "roblox-devforum-mcp") {
    this.level = level;
    this.loggerName = loggerName;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setServer(server: McpServer): void {
    this.server = server;
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;

    const payload = data ? { msg, ...data } : { msg };
    const sent = this.server?.server.sendLoggingMessage?.({
      level,
      logger: this.loggerName,
      data: payload,
    });

    if (sent && typeof (sent as Promise<unknown>).catch === "function") {
      (sent as Promise<unknown>).catch(() => {
        process.stderr.write(`[${level}] ${msg}\n`);
      });
    } else if (!this.server) {
      process.stderr.write(`[${level}] ${msg}\n`);
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.emit("info", msg, data);
  }
  notice(msg: string, data?: Record<string, unknown>): void {
    this.emit("notice", msg, data);
  }
  warning(msg: string, data?: Record<string, unknown>): void {
    this.emit("warning", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.emit("error", msg, data);
  }
}

export function createLogger(level: LogLevel = "info"): Logger {
  return new McpLogger(level);
}
