import { CARRY_MS } from "./historySeries";
import { HistoryPoint } from "./historyTypes";

/**
 * Availability timelines for the calendar view. Each limit of an account becomes
 * a lane of segments over [from, to]: the past from recorded history, the future
 * projected from the latest reading (a used-up limit stays blocked until its reset
 * time, then becomes free). An account's overall lane is blocked while any of its
 * limits is.
 */

/** free < 80% <= high < 100% <= limited; nodata where nothing is known. */
export type LaneState = "free" | "high" | "limited" | "nodata";

export const HIGH_PERCENT = 80;
export const LIMIT_PERCENT = 100;

export interface Segment {
  start: number;
  end: number;
  state: LaneState;
  /** highest percent seen in the segment (absent for nodata / overall) */
  percent?: number;
  /** true for the future part, which is a projection */
  projected: boolean;
}

export interface Lane {
  kind: string;
  label: string;
  segments: Segment[];
  /** reset times (epoch ms) inside the range */
  resets: number[];
}

export interface CurrentWindow {
  kind: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

export interface TimelineAccount {
  id: string;
  /** latest usage reading */
  windows: CurrentWindow[];
  fetchedAt?: number;
}

export interface Timeline {
  lanes: Lane[];
  overall: Segment[];
  /** when the account is usable again: `now` if it is, null if unknown */
  nextAvailableAt: number | null;
}

/** How an account's time in the shown period splits by state, for the past and the projected future. */
export interface TimelineStats {
  /** share (%) of the measured past that was free / 80%+ used / limited / unknown */
  past: Record<LaneState, number>;
  /** the same for the projected future */
  future: Record<LaneState, number>;
  /** milliseconds of measured past and projected future inside the range */
  pastMs: number;
  futureMs: number;
  /** longest stretch (ms) the account was limited in the past; 0 when never */
  longestBlockedMs: number;
  /** how many times a limit ran out in the past */
  blockedCount: number;
}

/** Splits the overall lane into per-state shares, past and future separately. */
export function timelineStats(overall: Segment[]): TimelineStats {
  const empty = (): Record<LaneState, number> => ({ free: 0, high: 0, limited: 0, nodata: 0 });
  const past = empty();
  const future = empty();
  let pastMs = 0;
  let futureMs = 0;
  let longest = 0;
  let count = 0;
  let prevLimited = false;
  for (const s of overall) {
    const ms = Math.max(0, s.end - s.start);
    if (s.projected) {
      future[s.state] += ms;
      futureMs += ms;
    } else {
      past[s.state] += ms;
      pastMs += ms;
      if (s.state === "limited") {
        if (!prevLimited) count++;
        longest = Math.max(longest, ms);
      }
      prevLimited = s.state === "limited";
    }
  }
  const pct = (bucket: Record<LaneState, number>, total: number) => {
    const out = empty();
    for (const k of Object.keys(bucket) as LaneState[]) out[k] = total > 0 ? Math.round((bucket[k] / total) * 1000) / 10 : 0;
    return out;
  };
  return { past: pct(past, pastMs), future: pct(future, futureMs), pastMs, futureMs, longestBlockedMs: longest, blockedCount: count };
}

const WEEK_MS = 7 * 86_400_000;

export function stateOf(percent: number): LaneState {
  return percent >= LIMIT_PERCENT ? "limited" : percent >= HIGH_PERCENT ? "high" : "free";
}

const RANK: Record<LaneState, number> = { nodata: 0, free: 1, high: 2, limited: 3 };

/** Merges neighbouring segments with the same state and projection. */
function merge(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    if (s.end <= s.start) continue;
    const prev = out[out.length - 1];
    if (prev && prev.state === s.state && prev.projected === s.projected && prev.end === s.start) {
      prev.end = s.end;
      if (s.percent !== undefined) prev.percent = Math.max(prev.percent ?? 0, s.percent);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function laneOrder(kind: string): number {
  return kind === "session" ? 0 : kind === "weekly_all" ? 1 : 2;
}

/** The past part of a lane: a step function over the readings, broken where readings stop. */
function pastSegments(readings: HistoryPoint[], kind: string, from: number, until: number): Segment[] {
  const segments: Segment[] = [];
  let cursor = from;
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    const next = readings[i + 1];
    const start = Math.max(r.t, from);
    const end = Math.min(next ? next.t : until, r.t + CARRY_MS, until);
    if (end <= from || start >= until) continue;
    if (start > cursor) segments.push({ start: cursor, end: start, state: "nodata", projected: false });
    const percent = r.w[kind];
    segments.push({ start, end, state: stateOf(percent), percent, projected: false });
    cursor = Math.max(cursor, end);
  }
  if (cursor < until) segments.push({ start: cursor, end: until, state: "nodata", projected: false });
  return segments;
}

/** The future part of a lane, projected from the latest reading. */
function futureSegments(w: CurrentWindow | undefined, from: number, to: number): { segments: Segment[]; resets: number[] } {
  if (from >= to) return { segments: [], resets: [] };
  if (!w) return { segments: [{ start: from, end: to, state: "nodata", projected: true }], resets: [] };
  const reset = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  if (!Number.isFinite(reset) || reset <= from) {
    // Unknown reset (or already passed): the reading holds as far as we know.
    return { segments: [{ start: from, end: to, state: stateOf(w.percent), percent: w.percent, projected: true }], resets: [] };
  }
  const segments: Segment[] = [
    { start: from, end: Math.min(reset, to), state: stateOf(w.percent), percent: w.percent, projected: true },
  ];
  const resets = reset < to ? [reset] : [];
  if (reset < to) {
    segments.push({ start: reset, end: to, state: "free", percent: 0, projected: true });
    // Weekly limits reset on a fixed weekly schedule; the session window starts with use.
    if (w.kind.startsWith("weekly")) {
      for (let t = reset + WEEK_MS; t < to; t += WEEK_MS) resets.push(t);
    }
  }
  return { segments, resets };
}

/** Worst state at every moment across lanes (any limited lane blocks the account). */
function overallOf(lanes: Lane[], from: number, to: number): Segment[] {
  const cuts = new Set<number>([from, to]);
  for (const lane of lanes) for (const s of lane.segments) cuts.add(s.start).add(s.end);
  const times = [...cuts].filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const start = times[i];
    const end = times[i + 1];
    const mid = (start + end) / 2;
    let state: LaneState = "nodata";
    let projected = false;
    let known = 0;
    for (const lane of lanes) {
      const s = lane.segments.find((x) => x.start <= mid && mid < x.end);
      if (!s) continue;
      projected = projected || s.projected;
      if (s.state !== "nodata") known++;
      if (RANK[s.state] > RANK[state]) state = s.state;
    }
    // Free only when every lane is known; one unknown lane leaves it open.
    if (state === "free" && known < lanes.length) state = "nodata";
    segments.push({ start, end, state, projected });
  }
  return merge(segments);
}

/** When the account can be used again, from its latest reading. */
export function nextAvailableAt(windows: CurrentWindow[], now: number): number | null {
  const blocked = windows.filter((w) => w.percent >= LIMIT_PERCENT);
  if (windows.length === 0) return null;
  if (blocked.length === 0) return now;
  const times = blocked.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN));
  return times.every(Number.isFinite) ? Math.max(now, ...times) : null;
}

export function buildTimeline(
  account: TimelineAccount,
  points: HistoryPoint[],
  from: number,
  to: number,
  now: number
): Timeline {
  const readings = points.filter((p) => p.id === account.id).sort((a, b) => a.t - b.t);
  const labels = new Map<string, string>();
  for (const p of readings) for (const k of Object.keys(p.w)) labels.set(k, p.n?.[k] ?? labels.get(k) ?? k);
  for (const w of account.windows) labels.set(w.kind, w.label);

  const split = Math.min(Math.max(now, from), to);
  const lanes: Lane[] = [...labels.entries()]
    .sort((a, b) => laneOrder(a[0]) - laneOrder(b[0]) || a[1].localeCompare(b[1]))
    .map(([kind, label]) => {
      const kindReadings = readings.filter((p) => typeof p.w[kind] === "number");
      const past = from < split ? pastSegments(kindReadings, kind, from, split) : [];
      const future = futureSegments(account.windows.find((w) => w.kind === kind), split, to);
      const pastResets = kindReadings
        .map((p) => (p.r?.[kind] ? Date.parse(p.r[kind]) : NaN))
        .filter((t) => Number.isFinite(t) && t >= from && t < split);
      return {
        kind,
        label,
        segments: merge([...past, ...future.segments]),
        resets: [...new Set([...pastResets, ...future.resets])].sort((a, b) => a - b),
      };
    });

  return {
    lanes,
    overall: lanes.length ? overallOf(lanes, from, to) : [{ start: from, end: to, state: "nodata", projected: to > now }],
    nextAvailableAt: nextAvailableAt(account.windows, now),
  };
}
