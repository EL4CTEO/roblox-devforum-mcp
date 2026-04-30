export class CircuitBreaker {
    threshold;
    windowMs;
    cooldownMs;
    hosts = new Map();
    constructor(threshold, windowMs, cooldownMs) {
        this.threshold = threshold;
        this.windowMs = windowMs;
        this.cooldownMs = cooldownMs;
    }
    isOpen(host) {
        const state = this.hosts.get(host);
        if (!state)
            return false;
        return Date.now() < state.openUntil;
    }
    recordSuccess(host) {
        this.hosts.delete(host);
    }
    recordFailure(host) {
        const now = Date.now();
        const state = this.hosts.get(host) ?? { failures: [], openUntil: 0 };
        state.failures = state.failures.filter((t) => now - t < this.windowMs);
        state.failures.push(now);
        if (state.failures.length >= this.threshold) {
            state.openUntil = now + this.cooldownMs;
            state.failures = [];
        }
        this.hosts.set(host, state);
    }
    reset() {
        this.hosts.clear();
    }
}
export function hostOf(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return url;
    }
}
//# sourceMappingURL=circuit.js.map