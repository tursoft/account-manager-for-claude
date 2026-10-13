/**
 * Color-coding of usage, shared by the pages and the status bar so that "warning" means
 * the same everywhere. Plain functions: no DOM, no Node, no VS Code.
 */

export type Tone = "ok" | "warn" | "danger";

/** danger from the warning threshold (80% by default), warn from 75% of it (60%), ok below. */
export function toneOfPercent(percent: number, warnThreshold = 80): Tone {
  return percent >= warnThreshold ? "danger" : percent >= warnThreshold * 0.75 ? "warn" : "ok";
}

interface UsageWindow {
  kind: string;
  label?: string;
  percent: number;
}

/** The part of an account these functions look at. */
export interface ToneAccount {
  windows: UsageWindow[];
  needsReauthorization?: boolean;
}

/** The first weekly limit (the general one or a model's, e.g. Fable) that is used up, if any. */
function consumedWeekly(acc: ToneAccount): UsageWindow | undefined {
  return (acc.windows || []).find((w) => w.kind.startsWith("weekly") && w.percent >= 100);
}

/** Percent used of the 5h session limit; the most used limit when there is no 5h reading; undefined without data. */
export function sessionPercent(acc: ToneAccount): number | undefined {
  const windows = acc.windows || [];
  const session = windows.find((w) => w.kind === "session");
  if (session) return session.percent;
  return windows.length ? Math.max(...windows.map((w) => w.percent)) : undefined;
}

/**
 * Tone of an account's name: green while the 5h limit has room, red once the 5h limit or a weekly
 * limit (the general one or a model's, such as Fable) is used up, since Claude then refuses
 * sessions too. Undefined when nothing is known or the login expired, so the usage cannot be trusted.
 */
export function nameTone(acc: ToneAccount): "ok" | "danger" | undefined {
  if (acc.needsReauthorization) return undefined;
  const windows = acc.windows || [];
  if (windows.length === 0) return undefined;
  return windows.some((w) => w.percent >= 100) ? "danger" : "ok";
}

/** A line for the name's tooltip explaining its color. */
export function nameToneDescription(acc: ToneAccount): string | undefined {
  if (acc.needsReauthorization) return undefined;
  const windows = acc.windows || [];
  const weekly = consumedWeekly(acc);
  if (weekly) return `${weekly.label || "Weekly limit"} used up: sessions are blocked too`;
  const used = windows.find((w) => w.percent >= 100);
  if (used) return used.kind === "session" ? "5h limit used up" : `${used.label || "A limit"} used up`;
  const percent = sessionPercent(acc);
  if (percent === undefined) return undefined;
  return windows.some((w) => w.kind === "session") ? `5h limit: ${percent}% used` : `Most used limit: ${percent}%`;
}

export type ResetTone = "imminent" | "soon" | "far";

/**
 * Color of the time left until a limit resets: under 10 min yellow, under 1 h orange, over 1 day
 * red, otherwise none. Only a limit that is used up (100%) gets a color; while some is left the
 * reset time stays gray.
 */
export function resetTone(percent: number, msLeft: number): ResetTone | undefined {
  if (percent < 100) return undefined;
  if (msLeft < 10 * 60_000) return "imminent";
  if (msLeft < 60 * 60_000) return "soon";
  if (msLeft > 24 * 3_600_000) return "far";
  return undefined;
}
