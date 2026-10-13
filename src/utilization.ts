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

// ---- breakdown by calendar period -------------------------------------------------

/**
 * How to group the range: recurring groups (every Monday together, every 9 o'clock hour
 * together) or consecutive spans (each week, each month).
 */
export type PeriodKind = "hour" | "weekday" | "week" | "month";

export interface PeriodBucket {
  /** stable key, e.g. "1" for Monday, "2026-W42", "2026-10", "9" for 09:00 */
  key: string;
  label: string;
  /** utilization (%) of the selected accounts together; null without data */
  utilization: number | null;
  usedBudgets: number;
  offeredBudgets: number;
  /** per selected account, in the order given; null = no data in this period */
  perAccount: (number | null)[];
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** ISO week number and its year for a local date. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; // Monday = 1 .. Sunday = 7
  t.setUTCDate(t.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return { year, week };
}

/** Start of the local calendar day containing `t`. */
function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Start of the local hour containing `t`. */
function startOfHour(t: number): number {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

export interface PeriodSlice {
  start: number;
  end: number;
  key: string;
  label: string;
}

/**
 * The consecutive calendar slices of [from, to) for `kind`, each with the key of the
 * group it belongs to. Hours and days are the atoms; weeks and months are their own slices.
 */
export function periodSlices(kind: PeriodKind, from: number, to: number): PeriodSlice[] {
  const out: PeriodSlice[] = [];
  if (kind === "hour") {
    for (let t = startOfHour(from); t < to; t += 3_600_000) {
      const h = new Date(t).getHours();
      out.push({ start: Math.max(t, from), end: Math.min(t + 3_600_000, to), key: String(h), label: `${String(h).padStart(2, "0")}:00` });
    }
    return out;
  }
  let t = startOfDay(from);
  while (t < to) {
    const d = new Date(t);
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    const start = Math.max(t, from);
    const end = Math.min(next.getTime(), to);
    if (kind === "weekday") {
      out.push({ start, end, key: String(d.getDay()), label: WEEKDAYS[d.getDay()] });
    } else if (kind === "week") {
      const { year, week } = isoWeek(d);
      out.push({ start, end, key: `${year}-W${String(week).padStart(2, "0")}`, label: `W${week}` });
    } else {
      out.push({ start, end, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` });
    }
    t = next.getTime();
  }
  return out;
}

/** Order of recurring groups: Monday first for weekdays, 0..23 for hours. */
function groupOrder(kind: PeriodKind, key: string): number {
  if (kind === "weekday") return (Number(key) + 6) % 7; // Mon=0 .. Sun=6
  if (kind === "hour") return Number(key);
  return 0;
}

/**
 * Utilization of a limit grouped by calendar period for the selected accounts: each period
 * compares what the accounts used inside it with the capacity they were offered inside it
 * (only the time an account was watched counts as offered). Recurring kinds (weekday, hour)
 * merge every occurrence in the range into one group; week and month keep each one apart.
 */
export function utilizationByPeriod(
  points: HistoryPoint[],
  accountIds: string[],
  kind: string,
  period: PeriodKind,
  from: number,
  to: number
): PeriodBucket[] {
  const slices = periodSlices(period, from, to);
  const cycle = cycleMs(kind);
  interface Group {
    label: string;
    used: number;
    offered: number;
    perUsed: number[];
    perOffered: number[];
    first: number;
  }
  const groups = new Map<string, Group>();
  const readingsByAccount = accountIds.map((id) =>
    points.filter((p) => p.id === id && typeof p.w[kind] === "number").sort((a, b) => a.t - b.t)
  );
  for (const slice of slices) {
    let g = groups.get(slice.key);
    if (!g) {
      g = { label: slice.label, used: 0, offered: 0, perUsed: accountIds.map(() => 0), perOffered: accountIds.map(() => 0), first: slice.start };
      groups.set(slice.key, g);
    }
    const group = g;
    readingsByAccount.forEach((readings, a) => {
      for (const [s, e] of coveredSpans(readings, slice.start, slice.end)) {
        const u = usedCapacityIn(readings, kind, s, e) ?? 0;
        const cap = ((e - s) / cycle) * 100;
        group.used += u;
        group.offered += cap;
        group.perUsed[a] += u;
        group.perOffered[a] += cap;
      }
    });
  }
  const ordered = [...groups.entries()].sort(([ka, ga], [kb, gb]) =>
    period === "weekday" || period === "hour" ? groupOrder(period, ka) - groupOrder(period, kb) : ga.first - gb.first
  );
  return ordered.map(([key, g]) => ({
    key,
    label: g.label,
    utilization: g.offered > 0 ? round1(Math.min(100, (g.used / g.offered) * 100)) : null,
    usedBudgets: round2(g.used / 100),
    offeredBudgets: round2(g.offered / 100),
    perAccount: g.perUsed.map((u, a) => (g.perOffered[a] > 0 ? round1(Math.min(100, (u / g.perOffered[a]) * 100)) : null)),
  }));
}
