interface HostState {
  failures: number[];
  openUntil: number;
}

export class CircuitBreaker {
  private readonly hosts = new Map<string, HostState>();

  constructor(
    private readonly threshold: number,
    private readonly windowMs: number,
    private readonly cooldownMs: number
  ) {}

  isOpen(host: string): boolean {
    const state = this.hosts.get(host);
    if (!state) return false;
    return Date.now() < state.openUntil;
  }

  recordSuccess(host: string): void {
    this.hosts.delete(host);
  }

  recordFailure(host: string): void {
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

  reset(): void {
    this.hosts.clear();
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
