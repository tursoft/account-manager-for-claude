import { AccountProfile, UsageSnapshot, UsageWindow } from "./types";

/** A limit counts as used up from 100%; below that the account can be used again. */
const EXHAUSTED_PERCENT = 100;
/** Grace period after `resets_at` before re-checking, so the server has rolled over. */
const RESET_RECHECK_DELAY_MS = 30_000;
/** setTimeout cannot wait longer than ~24.8 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface LimitReset {
  profileId: string;
  window: UsageWindow;
}

/** Windows that were used up in `previous` and are available again in `next`. */
export function findResetWindows(
  previous: UsageSnapshot | undefined,
  next: UsageSnapshot
): UsageWindow[] {
  if (!previous) {
    return [];
  }
  return next.windows.filter((w) => {
    const before = previous.windows.find((p) => p.kind === w.kind);
    return before !== undefined && before.percent >= EXHAUSTED_PERCENT && w.percent < EXHAUSTED_PERCENT;
  });
}

/**
 * Notices when a used-up limit (session, weekly, or a model-specific weekly limit)
 * becomes available again. Detection happens on every usage poll; in addition, a
 * one-off re-check is scheduled at each used-up limit's reset time, so the
 * notification arrives on time even with a long (or disabled) polling interval.
 */
export class LimitResetNotifier {
  private readonly timers = new Map<string, { at: number; timer: NodeJS.Timeout }>();

  constructor(
    private readonly notify: (reset: LimitReset) => void,
    private readonly recheck: (profileId: string) => void
  ) {}

  onSnapshot(profileId: string, previous: UsageSnapshot | undefined, next: UsageSnapshot): void {
    for (const window of findResetWindows(previous, next)) {
      this.notify({ profileId, window });
    }
  }

  /** (Re)schedules reset re-checks for every used-up limit of the given profiles. */
  schedule(profiles: AccountProfile[]): void {
    const wanted = new Map<string, { at: number; profileId: string }>();
    const now = Date.now();
    for (const profile of profiles) {
      for (const w of profile.lastUsage?.windows ?? []) {
        const resetAt = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
        if (w.percent >= EXHAUSTED_PERCENT && Number.isFinite(resetAt) && resetAt > now - RESET_RECHECK_DELAY_MS) {
          wanted.set(`${profile.id}:${w.kind}`, {
            at: resetAt + RESET_RECHECK_DELAY_MS,
            profileId: profile.id,
          });
        }
      }
    }

    for (const [key, existing] of this.timers) {
      if (wanted.get(key)?.at !== existing.at) {
        clearTimeout(existing.timer);
        this.timers.delete(key);
      }
    }
    for (const [key, { at, profileId }] of wanted) {
      if (this.timers.has(key)) {
        continue;
      }
      const delay = Math.max(0, at - now);
      if (delay > MAX_TIMER_MS) {
        continue; // picked up by a later schedule() call
      }
      const timer = setTimeout(() => {
        this.timers.delete(key);
        this.recheck(profileId);
      }, delay);
      this.timers.set(key, { at, timer });
    }
  }

  dispose(): void {
    for (const { timer } of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
