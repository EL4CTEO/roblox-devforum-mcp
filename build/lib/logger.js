const LEVEL_ORDER = {
    debug: 0,
    info: 1,
    notice: 2,
    warning: 3,
    error: 4,
};
class McpLogger {
    server;
    level;
    loggerName;
    constructor(level = "info", loggerName = "roblox-devforum-mcp") {
        this.level = level;
        this.loggerName = loggerName;
    }
    setLevel(level) {
        this.level = level;
    }
    setServer(server) {
        this.server = server;
    }
    emit(level, msg, data) {
        if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level])
            return;
        const payload = data ? { msg, ...data } : { msg };
        const sent = this.server?.server.sendLoggingMessage?.({
            level,
            logger: this.loggerName,
            data: payload,
        });
        if (sent && typeof sent.catch === "function") {
            sent.catch(() => {
                writeFallback(level, msg);
            });
        }
        else if (!this.server) {
            writeFallback(level, msg);
        }
    }
    debug(msg, data) {
        this.emit("debug", msg, data);
    }
    info(msg, data) {
        this.emit("info", msg, data);
    }
    notice(msg, data) {
        this.emit("notice", msg, data);
    }
    warning(msg, data) {
        this.emit("warning", msg, data);
    }
    error(msg, data) {
        this.emit("error", msg, data);
    }
}
function writeFallback(level, msg) {
    const line = `[${level}] ${msg}\n`;
    const proc = globalThis.process;
    if (proc?.stderr?.write) {
        proc.stderr.write(line);
    }
    else {
        console.error(line.trimEnd());
    }
}
export function createLogger(level = "info") {
    return new McpLogger(level);
}
//# sourceMappingURL=logger.js.map