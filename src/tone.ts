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

/**
 * A limit of one model only, such as the Fable weekly limit (`weekly_fable`): using it up
 * blocks that model, not the account. The 5h session limit and the general weekly limit
 * (`weekly_all`) apply to every model.
 */
function isModelLimit(kind: string): boolean {
  return /^(session|weekly)_.+$/.test(kind) && kind !== "weekly_all";
}

/** The used-up limit that blocks the whole account (the 5h or the general weekly limit), if any. */
function blockingLimit(acc: ToneAccount): UsageWindow | undefined {
  return (acc.windows || []).find((w) => w.percent >= 100 && !isModelLimit(w.kind));
}

/** Percent used of the 5h session limit; the most used account-wide limit without a 5h reading; undefined without data. */
export function sessionPercent(acc: ToneAccount): number | undefined {
  const windows = acc.windows || [];
  const session = windows.find((w) => w.kind === "session");
  if (session) return session.percent;
  const general = windows.filter((w) => !isModelLimit(w.kind));
  const pool = general.length ? general : windows;
  return pool.length ? Math.max(...pool.map((w) => w.percent)) : undefined;
}

/**
 * Tone of an account: green while it can start sessions, red once the 5h limit or the general
 * weekly limit is used up, since Claude then refuses sessions. A used-up model limit (such as
 * Fable) blocks only that model, so the account stays green. Undefined when nothing is known or
 * the login expired, so the usage cannot be trusted. The accounts panel, the availability
 * calendar, and the status bar all color accounts with it.
 */
export function nameTone(acc: ToneAccount): "ok" | "danger" | undefined {
  if (acc.needsReauthorization) return undefined;
  const windows = acc.windows || [];
  if (windows.length === 0) return undefined;
  return blockingLimit(acc) ? "danger" : "ok";
}

/** A line for the name's tooltip explaining its color. */
export function nameToneDescription(acc: ToneAccount): string | undefined {
  if (acc.needsReauthorization) return undefined;
  const windows = acc.windows || [];
  const blocking = blockingLimit(acc);
  if (blocking) {
    if (blocking.kind === "session") return "5h limit used up";
    return blocking.kind.startsWith("weekly")
      ? `${blocking.label || "Weekly limit"} used up: sessions are blocked too`
      : `${blocking.label || "A limit"} used up`;
  }
  const percent = sessionPercent(acc);
  if (percent === undefined) return undefined;
  const line = windows.some((w) => w.kind === "session") ? `5h limit: ${percent}% used` : `Most used limit: ${percent}%`;
  const model = windows.find((w) => w.percent >= 100);
  return model ? `${line}\n${model.label || "A model limit"} used up: only that model is blocked` : line;
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
