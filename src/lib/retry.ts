import { logger } from "./logger";

const log = logger("retry");

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "RetryableError";
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn`, retrying only when it throws a RetryableError.
 * Exponential backoff with jitter; honours retryAfterMs when given.
 */
export async function withRetry<T>(label: string, fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!(err instanceof RetryableError) || i === attempts) throw err;
      const backoff = Math.min(max, base * 2 ** (i - 1));
      const delay = err.retryAfterMs ?? Math.round(backoff * (0.75 + Math.random() * 0.5));
      log.warn(`${label} failed, retrying`, { attempt: i, of: attempts, delayMs: delay, error: err.message });
      await sleep(delay);
    }
  }
  throw lastError;
}
