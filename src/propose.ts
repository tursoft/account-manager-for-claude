/**
 * Proposes the best account to switch to for a limit: the one with the most of that
 * limit left, usable right now (no limit at all used up, since a used-up weekly limit
 * blocks sessions too), and with the reset time as the tie-breaker. Plain functions,
 * so the accounts panel, the extension, and the tests share one ranking.
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

export interface Proposal {
  account: ProposeAccount;
  /** percent of the limit still available */
  available: number;
  /** when the limit resets (epoch ms), if known */
  resetsAt: number | null;
  /** one sentence saying why this account */
  reason: string;
  /** accounts that were considered, best first (the proposal is the first) */
  ranked: ProposeAccount[];
}

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

function fmtWait(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 ? `${hours} h ${mins % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/**
 * Ranks the accounts for `kind`. Usable accounts that have the limit come first, by
 * most available; equal availability prefers the later reset (its budget lasts longer
 * before being lost), then the account's list order. Accounts without the limit, blocked
 * accounts, and expired logins are not proposed.
 */
export function rankAccounts(accounts: ProposeAccount[], kind: ProposeFor, now = Date.now()): ProposeAccount[] {
  const candidates = accounts.filter((a) => usable(a) && windowOf(a, kind));
  const order = new Map(accounts.map((a, i) => [a.id, i]));
  return candidates.slice().sort((a, b) => {
    const wa = windowOf(a, kind)!;
    const wb = windowOf(b, kind)!;
    const avail = wb.percent - wa.percent; // less used first
    if (avail) return -avail > 0 ? 1 : -1;
    const ra = resetMs(wa) ?? now;
    const rb = resetMs(wb) ?? now;
    if (ra !== rb) return rb - ra; // later reset first
    return (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });
}

/** The best account for `kind`, with a one-sentence reason; null when none can be used. */
export function propose(accounts: ProposeAccount[], kind: ProposeFor, now = Date.now()): Proposal | null {
  const ranked = rankAccounts(accounts, kind, now);
  const account = ranked[0];
  if (!account) return null;
  const w = windowOf(account, kind)!;
  const available = 100 - w.percent;
  const resetsAt = resetMs(w);
  const name = limitName(kind);
  const others = ranked.length - 1;
  const parts: string[] = [];
  parts.push(`${available}% of its ${name} limit is available`);
  if (others > 0) {
    const runnerUp = windowOf(ranked[1], kind)!;
    const diff = w.percent < runnerUp.percent ? `the most of the ${others === 1 ? "other usable account" : `${others} other usable accounts`}` : null;
    if (diff) parts.push(diff);
    else if (resetsAt !== null) parts.push(`same as the next account, but its limit resets later`);
  }
  if (resetsAt !== null) {
    parts.push(`it resets in ${fmtWait(Math.max(0, resetsAt - now))}`);
  }
  // "A.", "A, and B.", "A, B, and C."
  const tail = parts.slice(1);
  let reason = parts[0] + (tail.length === 0 ? "" : tail.length === 1 ? `, and ${tail[0]}` : `, ${tail.slice(0, -1).join(", ")}, and ${tail[tail.length - 1]}`) + ".";
  reason = reason.charAt(0).toUpperCase() + reason.slice(1);
  if (account.isActive) reason = `It is already the active account: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
  return { account, available, resetsAt, reason, ranked };
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
