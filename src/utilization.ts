import { CARRY_MS, bucketStarts } from "./historySeries";
import { HistoryPoint } from "./historyTypes";

/**
 * Capacity utilization: how much of the capacity a limit offered was actually used.
 *
 * Each limit is a budget (100%) that refills on a fixed cycle: the 5h session limit
 * every 5 hours, weekly limits (the general one, Fable, ...) every 7 days. Whatever is
 * not used before the reset is lost. Utilization over a period is therefore
 *
 *     used capacity / offered capacity
 *
 * where a period that spans N cycles offers N budgets (fractional cycles count
 * fractionally), and the usage is the sum of the percent increases between readings
 * (a drop means the limit reset: the new level counts from zero).
 *
 * Plain functions over plain objects, so the webview bundles can import them.
 */

export const SESSION_CYCLE_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 86_400_000;

/** Length of a limit's reset cycle. */
export function cycleMs(kind: string): number {
  return kind === "session" ? SESSION_CYCLE_MS : WEEK_MS;
}

/** Percent of capacity consumed between two consecutive readings (a drop = a reset). */
export function usedBetween(previous: number, next: number): number {
  return next >= previous ? next - previous : next;
}

/** Capacity can never be used beyond what was offered; readings are rounded percents, so clamp the ratio. */
function ratio(used: number, offered: number): number {
  return Math.min(100, (used / offered) * 100);
}

/**
 * Capacity used by one account's limit inside [from, to): the sum of the increases
 * between consecutive readings, counting a reading pair into the window it falls in
 * (an increase spanning the edge is split proportionally to the time inside). Gaps
 * longer than CARRY_MS mean collection was off; nothing is counted across them.
 * Returns null when the account has no readings touching the window.
 */
export function usedCapacityIn(readings: HistoryPoint[], kind: string, from: number, to: number): number | null {
  let used = 0;
  let touched = false;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    if (b.t <= from || a.t >= to) continue;
    touched = true;
    if (b.t - a.t > CARRY_MS) continue;
    const increase = usedBetween(a.w[kind], b.w[kind]);
    if (increase <= 0) continue;
    const span = b.t - a.t;
    const inside = Math.min(b.t, to) - Math.max(a.t, from);
    used += span > 0 ? (increase * inside) / span : increase;
  }
  // A single reading inside the window still counts as "touched" (we know the account was watched).
  if (!touched && readings.some((r) => r.t >= from && r.t < to)) touched = true;
  return touched ? used : null;
}

/** Percent of the offered capacity that was used in [from, to) for one account's limit. */
export function utilizationIn(
  readings: HistoryPoint[],
  kind: string,
  from: number,
  to: number
): number | null {
  const used = usedCapacityIn(readings, kind, from, to);
  if (used === null) return null;
  const offered = ((to - from) / cycleMs(kind)) * 100;
  return offered > 0 ? ratio(used, offered) : null;
}

export interface UtilizationSeries {
  /** chart bucket starts */
  starts: number[];
  /** utilization (%) of the selected accounts together, per bucket; null = no data */
  values: (number | null)[];
  /** per-account utilization per bucket, same order as `accountIds` */
  perAccount: (number | null)[][];
}

/** Readings of one account for one limit, sorted by time. */
function readingsOf(points: HistoryPoint[], accountId: string, kind: string): HistoryPoint[] {
  return points
    .filter((p) => p.id === accountId && typeof p.w[kind] === "number")
    .sort((a, b) => a.t - b.t);
}

/**
 * Utilization per bucket for a limit: each bucket compares what the selected accounts
 * used inside it with the capacity those accounts were offered in it. An account without
 * readings in a bucket is left out of that bucket (it adds neither usage nor capacity).
 */
export function utilizationSeries(
  points: HistoryPoint[],
  accountIds: string[],
  kind: string,
  from: number,
  to: number,
  bucketMs: number
): UtilizationSeries {
  const starts = bucketStarts(from, to, bucketMs);
  const perAccount = accountIds.map(() => new Array<number | null>(starts.length).fill(null));
  const values: (number | null)[] = new Array(starts.length).fill(null);
  const byAccount = accountIds.map((id) => readingsOf(points, id, kind));

  starts.forEach((start, b) => {
    const end = Math.min(start + bucketMs, to);
    let used = 0;
    let offered = 0;
    byAccount.forEach((readings, a) => {
      const u = usedCapacityIn(readings, kind, start, end);
      if (u === null) return;
      const cap = ((end - start) / cycleMs(kind)) * 100;
      perAccount[a][b] = cap > 0 ? round1(ratio(u, cap)) : null;
      used += u;
      offered += cap;
    });
    values[b] = offered > 0 ? round1(ratio(used, offered)) : null;
  });
  return { starts, values, perAccount };
}

export interface UtilizationSummary {
  kind: string;
  label: string;
  /** utilization of the selected accounts together over the whole range; null without data */
  overall: number | null;
  /** capacity used, in "budgets" (1 = one full limit) */
  usedBudgets: number;
  /** capacity offered, in budgets */
  offeredBudgets: number;
  /** per account: id, utilization over the range, and whether it had data */
  accounts: { id: string; utilization: number | null }[];
}

/** Overall utilization of a limit over [from, to) for the selected accounts, plus per account. */
export function utilizationSummary(
  points: HistoryPoint[],
  accountIds: string[],
  kind: string,
  label: string,
  from: number,
  to: number
): UtilizationSummary {
  let used = 0;
  let offered = 0;
  const accounts = accountIds.map((id) => {
    const readings = readingsOf(points, id, kind);
    // Only the part of the range the account was actually watched counts as offered.
    const covered = coveredSpans(readings, from, to);
    let u = 0;
    let cap = 0;
    for (const [s, e] of covered) {
      u += usedCapacityIn(readings, kind, s, e) ?? 0;
      cap += ((e - s) / cycleMs(kind)) * 100;
    }
    used += u;
    offered += cap;
    return { id, utilization: cap > 0 ? round1(ratio(u, cap)) : null };
  });
  return {
    kind,
    label,
    overall: offered > 0 ? round1(ratio(used, offered)) : null,
    usedBudgets: round2(used / 100),
    offeredBudgets: round2(offered / 100),
    accounts,
  };
}

/** The parts of [from, to) in which readings keep coming (gaps longer than CARRY_MS are left out). */
export function coveredSpans(readings: HistoryPoint[], from: number, to: number): [number, number][] {
  const spans: [number, number][] = [];
  let open: [number, number] | null = null;
  for (let i = 0; i < readings.length; i++) {
    const t = Math.min(Math.max(readings[i].t, from), to);
    const prev = readings[i - 1];
    if (!open || (prev && readings[i].t - prev.t > CARRY_MS)) {
      if (open && open[1] > open[0]) spans.push(open);
      open = [t, t];
    }
    open[1] = t;
  }
  if (open && open[1] > open[0]) spans.push(open);
  return spans.filter(([s, e]) => e > s && e > from && s < to);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
