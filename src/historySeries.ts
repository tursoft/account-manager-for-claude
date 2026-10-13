import { HISTORY_HEARTBEAT_MS, HistoryPoint } from "./historyTypes";

/**
 * Turns recorded usage readings into chart series. Each account's readings of a
 * limit form a step function: a value holds until the next reading, as long as
 * readings keep coming (the recorder writes at least every heartbeat).
 */

/** A value older than this is not carried forward: collection was off or failing. */
export const CARRY_MS = 2 * HISTORY_HEARTBEAT_MS;

/** "used" = percent of the limit used; "available" = percent of it still left (100 minus used). */
export type SeriesMode = "used" | "available";

export interface LimitKind {
  kind: string;
  label: string;
}

/** Limit kinds present in `points`: session first, then the general weekly limit, then scoped ones. */
export function kindsIn(points: HistoryPoint[]): LimitKind[] {
  const labels = new Map<string, string>();
  for (const p of points) {
    for (const kind of Object.keys(p.w)) {
      if (!labels.has(kind) || p.n?.[kind]) {
        labels.set(kind, p.n?.[kind] ?? kind);
      }
    }
  }
  const rank = (k: string) => (k === "session" ? 0 : k === "weekly_all" ? 1 : 2);
  return [...labels.entries()]
    .map(([kind, label]) => ({ kind, label }))
    .sort((a, b) => rank(a.kind) - rank(b.kind) || a.label.localeCompare(b.label));
}

/** Bucket width that keeps a range readable (about 50-170 buckets). */
export function bucketSizeFor(rangeMs: number): number {
  const steps = [5, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * 60_000);
  return steps.find((s) => rangeMs / s <= 170) ?? steps[steps.length - 1];
}

/** Start times of the buckets covering [from, to). */
export function bucketStarts(from: number, to: number, bucketMs: number): number[] {
  const starts: number[] = [];
  for (let t = from; t < to; t += bucketMs) {
    starts.push(t);
  }
  return starts;
}

/**
 * One value per bucket for an account's limit; null where nothing is known.
 * A bucket takes the busiest moment in it: "used" shows the highest percent used,
 * "available" the lowest percent left (100 minus that).
 * `points` may include readings before `from`, which seed the first buckets.
 */
export function bucketSeries(
  points: HistoryPoint[],
  accountId: string,
  kind: string,
  from: number,
  to: number,
  bucketMs: number,
  mode: SeriesMode
): (number | null)[] {
  const readings = points
    .filter((p) => p.id === accountId && typeof p.w[kind] === "number")
    .sort((a, b) => a.t - b.t);
  const starts = bucketStarts(from, to, bucketMs);
  const values: (number | null)[] = new Array(starts.length).fill(null);
  if (readings.length === 0) {
    return values;
  }

  let i = 0;
  let last: HistoryPoint | undefined;
  // Seed with the latest reading before the range.
  while (i < readings.length && readings[i].t < from) {
    last = readings[i++];
  }

  for (let b = 0; b < starts.length; b++) {
    const start = starts[b];
    const end = start + bucketMs;
    const carried = last && start - last.t <= CARRY_MS ? last : undefined;
    let max = carried ? carried.w[kind] : null;
    while (i < readings.length && readings[i].t < end) {
      const r = readings[i++];
      const v = r.w[kind];
      max = max === null ? v : Math.max(max, v);
      last = r;
    }
    if (max !== null) {
      values[b] = mode === "used" ? max : 100 - max;
    }
  }
  return values;
}

/** One number per account for pie charts: the average over the buckets that have data. */
export function seriesTotal(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  if (known.length === 0) {
    return null;
  }
  return Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10;
}
