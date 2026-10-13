/**
 * Proposes accounts to switch to for a limit. Capacity that is not used before a limit
 * resets is lost, so the order is urgency first: how much of the limit is available per
 * hour until it resets (an account with 40% left and an hour to go beats one with 90%
 * left and a fresh 5-hour budget). Only accounts that can be used right now count: a
 * used-up weekly limit blocks sessions too, and an expired login cannot be used at all.
 * Plain functions, so the accounts panel, the extension, and the tests share one ranking.
 */

export interface ProposeWindow {
  kind: string;
  label?: string;
  percent: number;
  resetsAt: string | null;
}

export interface ProposeAccount {
  id: string;
  label: string;
  isActive?: boolean;
  needsReauthorization?: boolean;
  windows: ProposeWindow[];
}

/** Which limit the proposal is about: the 5h session limit, or a weekly limit by kind (e.g. weekly_fable). */
export type ProposeFor = "session" | `weekly_${string}`;

export interface Candidate {
  account: ProposeAccount;
  /** percent of the limit still available */
  available: number;
  /** when the limit resets (epoch ms), if known */
  resetsAt: number | null;
  /** available percent per hour until the reset; Infinity when the reset is imminent */
  urgency: number;
  /** one sentence saying why this account is here */
  reason: string;
}

export interface Proposal {
  /** the best account (= candidates[0].account) */
  account: ProposeAccount;
  available: number;
  resetsAt: number | null;
  reason: string;
  /** the best candidates in order (at most 3) */
  candidates: Candidate[];
  /** every usable account, best first */
  ranked: ProposeAccount[];
}

/** How many candidates a proposal lists. */
export const PROPOSAL_COUNT = 3;

/** The cycle length of a limit, used when its reset time is unknown. */
const CYCLE_HOURS: Record<string, number> = { session: 5 };
const WEEK_HOURS = 7 * 24;

export function limitName(kind: string): string {
  if (kind === "session") return "5h";
  if (kind === "weekly_all") return "weekly";
  const scope = kind.replace(/^weekly_/, "");
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

function windowOf(acc: ProposeAccount, kind: string): ProposeWindow | undefined {
  return (acc.windows || []).find((w) => w.kind === kind);
}

/** An account can be used when its login works and no limit at all is used up. */
function usable(acc: ProposeAccount): boolean {
  return !acc.needsReauthorization && (acc.windows || []).length > 0 && !(acc.windows || []).some((w) => w.percent >= 100);
}

function resetMs(w: ProposeWindow | undefined): number | null {
  const t = w?.resetsAt ? Date.parse(w.resetsAt) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Hours until the limit resets; the full cycle when the reset time is unknown. */
function hoursToReset(w: ProposeWindow, kind: string, now: number): number {
  const at = resetMs(w);
  if (at === null) return CYCLE_HOURS[kind] ?? WEEK_HOURS;
  return Math.max(0, (at - now) / 3_600_000);
}

/**
 * Available percent per hour until the reset: the higher, the more capacity would be
 * lost by waiting. A limit that resets within a few minutes with capacity left is
 * the most urgent of all.
 */
export function urgencyOf(w: ProposeWindow, kind: string, now: number): number {
  const available = 100 - w.percent;
  if (available <= 0) return 0;
  const hours = hoursToReset(w, kind, now);
  return hours < 1 / 12 ? Infinity : available / hours;
}

export function fmtWait(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/**
 * Ranks the accounts for `kind`: usable accounts that have the limit, most urgent first
 * (available per hour until reset), then the most available, then the list order.
 */
export function rankAccounts(accounts: ProposeAccount[], kind: ProposeFor, now = Date.now()): ProposeAccount[] {
  const candidates = accounts.filter((a) => usable(a) && windowOf(a, kind));
  const order = new Map(accounts.map((a, i) => [a.id, i]));
  return candidates.slice().sort((a, b) => {
    const wa = windowOf(a, kind)!;
    const wb = windowOf(b, kind)!;
    const ua = urgencyOf(wa, kind, now);
    const ub = urgencyOf(wb, kind, now);
    if (ua !== ub) return ub > ua ? 1 : -1; // more urgent first
    if (wa.percent !== wb.percent) return wa.percent - wb.percent; // more available first
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

/** One sentence for a candidate: how much is available, why it is urgent, when it resets. */
function reasonFor(acc: ProposeAccount, kind: ProposeFor, rank: number, others: number, now: number): string {
  const w = windowOf(acc, kind)!;
  const available = 100 - w.percent;
  const resetsAt = resetMs(w);
  const name = limitName(kind);
  const wait = resetsAt === null ? null : Math.max(0, resetsAt - now);
  const parts: string[] = [`${available}% of its ${name} limit is available`];
  if (wait !== null) {
    const soon = wait < 3_600_000;
    parts.push(
      soon
        ? `it resets in ${fmtWait(wait)}, so use that capacity now or lose it`
        : `it resets in ${fmtWait(wait)}`
    );
  } else {
    parts.push("its reset time is not known");
  }
  if (rank === 0 && others > 0) {
    parts.push(`the most urgent of the ${others + 1} usable accounts`);
  }
  const tail = parts.slice(1);
  let reason = parts[0] + (tail.length === 0 ? "" : tail.length === 1 ? `, and ${tail[0]}` : `, ${tail.slice(0, -1).join(", ")}, and ${tail[tail.length - 1]}`) + ".";
  reason = reason.charAt(0).toUpperCase() + reason.slice(1);
  if (acc.isActive) reason = `It is already the active account: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
  return reason;
}

/** The best accounts for `kind` (up to PROPOSAL_COUNT), each with a reason; null when none can be used. */
export function propose(accounts: ProposeAccount[], kind: ProposeFor, now = Date.now()): Proposal | null {
  const ranked = rankAccounts(accounts, kind, now);
  if (ranked.length === 0) return null;
  const candidates: Candidate[] = ranked.slice(0, PROPOSAL_COUNT).map((account, i) => {
    const w = windowOf(account, kind)!;
    return {
      account,
      available: 100 - w.percent,
      resetsAt: resetMs(w),
      urgency: urgencyOf(w, kind, now),
      reason: reasonFor(account, kind, i, ranked.length - 1, now),
    };
  });
  const best = candidates[0];
  return { account: best.account, available: best.available, resetsAt: best.resetsAt, reason: best.reason, candidates, ranked };
}

/** Why nothing can be proposed for `kind`, in one sentence. */
export function noProposalReason(accounts: ProposeAccount[], kind: ProposeFor, now = Date.now()): string {
  const name = limitName(kind);
  const withLimit = accounts.filter((a) => windowOf(a, kind));
  if (withLimit.length === 0) return `No account reports a ${name} limit.`;
  const working = withLimit.filter((a) => !a.needsReauthorization);
  if (working.length === 0) return `Every account with a ${name} limit has an expired login; reauthorize one first.`;
  // All blocked: say when the first frees up.
  const soonest = working
    .map((a) => Math.max(...(a.windows || []).filter((w) => w.percent >= 100).map((w) => resetMs(w) ?? Infinity)))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  if (soonest !== undefined) return `Every account is used up; the first is usable again in ${fmtWait(Math.max(0, soonest - now))}.`;
  return `Every account is used up and no reset time is known.`;
}
