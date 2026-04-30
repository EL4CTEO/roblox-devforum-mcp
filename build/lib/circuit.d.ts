export declare class CircuitBreaker {
    private readonly threshold;
    private readonly windowMs;
    private readonly cooldownMs;
    private readonly hosts;
    constructor(threshold: number, windowMs: number, cooldownMs: number);
    isOpen(host: string): boolean;
    recordSuccess(host: string): void;
    recordFailure(host: string): void;
    reset(): void;
}
export declare function hostOf(url: string): string;
