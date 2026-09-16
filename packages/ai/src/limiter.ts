export type LimiterConfig = {
  name: string;
  requestsPerMinute: number;
  tokensPerMinute: number;
  requestsPerDay?: number;
  tokensPerDay?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Entry = { at: number; tokens: number };

export type Reservation = {
  /**
   * Replace the estimate with what the provider actually billed. Always call
   * this — an un-reconciled reservation leaves the window holding a guess.
   */
  settle: (actualTokens: number) => void;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Sliding-window limiter over BOTH requests and tokens.
 *
 * Tokens are the point. Groq allows 30 RPM but only 8000 TPM, so a handful of
 * ordinary Tutor requests exhausts the token budget long before the request
 * budget — a request-only limiter would wave everything through and collect
 * 429s (CLAUDE.md: "TPM is the binding constraint, not RPM").
 *
 * Reserve-then-settle: the caller reserves an estimate before the request and
 * corrects it afterwards with real usage. Reserving up front is what prevents
 * concurrent callers from collectively overshooting; correcting afterwards is
 * what stops a conservative estimate from permanently under-using the quota.
 * It matters here because reasoning tokens make completion size genuinely hard
 * to predict (D-016).
 *
 * Scope: per process. Two Railway services each hold their own window, so the
 * configured limits are split between them rather than shared. See D-022.
 */
export class RateLimiter {
  private readonly window: Entry[] = [];
  private readonly day: Entry[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes admission so two callers cannot both pass the same check. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: LimiterConfig) {
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? defaultSleep;
  }

  private prune(at: number): void {
    const minuteAgo = at - 60_000;
    while (this.window.length > 0 && this.window[0]!.at <= minuteAgo) this.window.shift();
    const dayAgo = at - 86_400_000;
    while (this.day.length > 0 && this.day[0]!.at <= dayAgo) this.day.shift();
  }

  private usage(entries: Entry[]): { requests: number; tokens: number } {
    let tokens = 0;
    for (const e of entries) tokens += e.tokens;
    return { requests: entries.length, tokens };
  }

  /** How long until the oldest in-window entry expires and frees capacity. */
  private waitMs(at: number): number {
    if (this.window.length === 0) return 50;
    return Math.max(25, this.window[0]!.at + 60_000 - at + 5);
  }

  snapshot(): { requests: number; tokens: number; requestsToday: number; tokensToday: number } {
    this.prune(this.now());
    const minute = this.usage(this.window);
    const today = this.usage(this.day);
    return {
      requests: minute.requests,
      tokens: minute.tokens,
      requestsToday: today.requests,
      tokensToday: today.tokens,
    };
  }

  async reserve(estimatedTokens: number): Promise<Reservation> {
    // Chain onto the previous admission so the check-and-record pair is atomic
    // with respect to other callers in this process.
    const admitted = this.queue.then(() => this.admit(estimatedTokens));
    this.queue = admitted.then(
      () => undefined,
      () => undefined,
    );
    return admitted;
  }

  private async admit(estimatedTokens: number): Promise<Reservation> {
    const estimate = Math.max(1, Math.ceil(estimatedTokens));

    for (;;) {
      const at = this.now();
      this.prune(at);
      const minute = this.usage(this.window);
      const today = this.usage(this.day);

      const dailyRequestsExceeded =
        this.config.requestsPerDay !== undefined && today.requests >= this.config.requestsPerDay;
      const dailyTokensExceeded =
        this.config.tokensPerDay !== undefined &&
        today.tokens + estimate > this.config.tokensPerDay;

      // A daily cap cannot be waited out in any useful timeframe. Fail loudly
      // rather than hanging a request for hours.
      if (dailyRequestsExceeded || dailyTokensExceeded) {
        throw new Error(
          `${this.config.name}: daily quota exhausted ` +
            `(${today.requests} requests, ${today.tokens} tokens today). ` +
            `Resets on a rolling 24h window.`,
        );
      }

      const fits =
        minute.requests < this.config.requestsPerMinute &&
        minute.tokens + estimate <= this.config.tokensPerMinute;

      if (fits) {
        const entry: Entry = { at, tokens: estimate };
        this.window.push(entry);
        this.day.push(entry);
        let settled = false;
        return {
          settle: (actualTokens: number) => {
            // Mutating the shared entry object updates both windows at once.
            if (settled) return;
            settled = true;
            entry.tokens = Math.max(0, Math.ceil(actualTokens));
          },
        };
      }

      // A single request larger than the whole per-minute budget can never fit;
      // waiting would block forever.
      if (estimate > this.config.tokensPerMinute) {
        throw new Error(
          `${this.config.name}: request needs ~${estimate} tokens but the ` +
            `per-minute ceiling is ${this.config.tokensPerMinute}. Shorten the prompt.`,
        );
      }

      await this.sleep(this.waitMs(at));
    }
  }
}
