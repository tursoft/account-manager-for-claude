/**
 * Runs requests one at a time, with a pause between them.
 *
 * Anthropic's usage endpoint is rate-limited per user, and several accounts checked at once
 * (a poll, a card's Refresh, a limit-reset re-check, the current login) easily hit HTTP 429.
 * Every usage and profile request goes through one queue: a request starts only after the
 * previous one has finished and `gapMs` has passed since then. A failing request does not
 * stop the ones after it.
 */
export class RequestQueue {
  private tail: Promise<void> = Promise.resolve();
  private lastEnd = 0;

  constructor(private gapMs: number) {}

  /** Changes the pause between requests (applies from the next request on). */
  setGap(ms: number): void {
    this.gapMs = Math.max(0, ms);
  }

  get gap(): number {
    return this.gapMs;
  }

  /** Queues `task`; resolves or rejects with its result once it has run. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastEnd + this.gapMs - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      try {
        return await task();
      } finally {
        this.lastEnd = Date.now();
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** Default pause between requests to Anthropic, in seconds (setting: requestDelaySeconds). */
export const DEFAULT_REQUEST_DELAY_SECONDS = 2;

/** The one queue for usage and profile requests to Anthropic. */
export const anthropicQueue = new RequestQueue(DEFAULT_REQUEST_DELAY_SECONDS * 1000);
