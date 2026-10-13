/**
 * Sorting and filtering of the account list, shared by the accounts panel and the
 * availability calendar so both behave the same. Plain functions over plain objects:
 * no DOM, no Node, no VS Code, so webview bundles can import it.
 */

export type LimitFilter = "all" | "available" | "limited";
export type SortKey = "custom" | "available" | "remaining" | "reset" | "plan" | "name";

/** One usage limit of an account, as the views receive it. */
export interface ListWindow {
  kind: string;
  label: string;
  percent: number;
  resetsAt: string | null;
}

/** The part of an account these functions look at. */
export interface ListAccount {
  id: string;
  label: string;
  subscriptionType?: string;
  isActive?: boolean;
  windows: ListWindow[];
}

export interface ListingSettings {
  /** Free text matched against the name, the plan, and "active". */
  text: string;
  limit: LimitFilter;
  /** "all", or a lower-case plan such as "team". */
  plan: string;
  /** "any", or "has:<key>" / "no:<key>" for a model-specific limit such as "has:fable". */
  scope: string;
  sort: SortKey;
}

export const DEFAULT_LISTING: ListingSettings = {
  text: "",
  limit: "all",
  plan: "all",
  scope: "any",
  sort: "custom",
};

export const SORTS: { key: SortKey; label: string }[] = [
  { key: "custom", label: "Custom order (drag to reorder)" },
  { key: "available", label: "Available first, then soonest available" },
  { key: "remaining", label: "Most usage left first" },
  { key: "reset", label: "Resetting soonest first" },
  { key: "plan", label: "Plan (Enterprise, Team, Max, Pro, Free)" },
  { key: "name", label: "Name A–Z" },
];

const LIMIT_FILTERS: LimitFilter[] = ["all", "available", "limited"];

/** Validates settings from storage, a backup, or a message; invalid parts fall back to the defaults. */
export function normalizeListing(raw: unknown): ListingSettings {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);
  const scope = text(r.scope);
  return {
    text: text(r.text) ?? DEFAULT_LISTING.text,
    limit: LIMIT_FILTERS.find((l) => l === r.limit) ?? DEFAULT_LISTING.limit,
    plan: text(r.plan)?.trim().toLowerCase() || DEFAULT_LISTING.plan,
    scope: scope && /^(has|no):.+$/.test(scope) ? scope : DEFAULT_LISTING.scope,
    sort: SORTS.find((s) => s.key === r.sort)?.key ?? DEFAULT_LISTING.sort,
  };
}

/** "limited" = some limit used up; "available" = usage known and every limit below 100%. */
export function limitState(acc: ListAccount): "limited" | "available" | "unknown" {
  const windows = acc.windows || [];
  if (windows.some((w) => w.percent >= 100)) return "limited";
  return windows.length > 0 ? "available" : "unknown";
}

/** Account type, lower-cased ("pro", "max", "team", ...); "unknown" when not reported. */
export function planOf(acc: ListAccount): string {
  return (acc.subscriptionType || "").trim().toLowerCase() || "unknown";
}

export function planName(plan: string): string {
  return plan === "unknown" ? "Unknown plan" : plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Model-specific weekly limits of an account, e.g. { fable: "Fable" } (no prototype, so `in` is safe). */
export function scopesOf(acc: ListAccount): Record<string, string> {
  const scopes: Record<string, string> = Object.create(null);
  for (const w of acc.windows || []) {
    const key = /^weekly_(.+)$/.exec(w.kind || "")?.[1];
    if (!key || key === "all") continue;
    scopes[key] = /\((.+)\)/.exec(w.label || "")?.[1] || key;
  }
  return scopes;
}

/** Time (ms) at which every used-up limit of the account is available again; 0 = usable now. */
function availableAt(acc: ListAccount): number {
  const windows = acc.windows || [];
  if (windows.length === 0) return Infinity;
  let at = 0;
  for (const w of windows) {
    if (w.percent < 100) continue;
    const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
    at = Math.max(at, Number.isFinite(t) ? t : Infinity);
  }
  return at;
}

/** Earliest upcoming reset of any limit; Infinity when unknown. */
function nextReset(acc: ListAccount): number {
  const times = (acc.windows || [])
    .map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN))
    .filter(Number.isFinite);
  return times.length ? Math.min(...times) : Infinity;
}

/** Percent left on the most used limit; -1 when usage is unknown. */
function headroom(acc: ListAccount): number {
  const windows = acc.windows || [];
  return windows.length ? 100 - Math.max(...windows.map((w) => w.percent)) : -1;
}

const PLAN_ORDER = ["enterprise", "team", "max", "pro", "free"];

/** Larger plans first; plans not in PLAN_ORDER after them, unknown last. */
function planRank(acc: ListAccount): number {
  const plan = planOf(acc);
  const i = PLAN_ORDER.indexOf(plan);
  return i >= 0 ? i : plan === "unknown" ? PLAN_ORDER.length + 1 : PLAN_ORDER.length;
}

/** Whether `acc` passes the filters (text, limit state, plan, model-specific limit). */
export function matchesListing(acc: ListAccount, s: ListingSettings): boolean {
  if (s.limit !== "all" && limitState(acc) !== s.limit) return false;
  if (s.plan !== "all" && planOf(acc) !== s.plan) return false;
  if (s.scope !== "any") {
    const [mode, key] = s.scope.split(":");
    if ((key in scopesOf(acc)) !== (mode === "has")) return false;
  }
  const q = s.text.trim().toLowerCase();
  if (!q) return true;
  return [acc.label, acc.subscriptionType, acc.isActive ? "active" : ""]
    .filter(Boolean)
    .some((t) => (t as string).toLowerCase().includes(q));
}

/**
 * Orders `list` by `sort`; ties (and the "custom" sort) keep the user's order, given
 * as `order` = account id -> position in the full, user-ordered list.
 */
export function sortAccounts<T extends ListAccount>(list: T[], order: Map<string, number>, sort: SortKey): T[] {
  if (sort === "custom") return list;
  const byOrder = (a: T, b: T) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  const rank = (x: ListAccount) => {
    const state = limitState(x);
    return state === "available" ? 0 : state === "unknown" ? 1 : 2;
  };
  const cmp: Record<Exclude<SortKey, "custom">, (a: T, b: T) => number> = {
    available: (a, b) => {
      const r = rank(a) - rank(b);
      if (r) return r;
      if (rank(a) === 0) return headroom(b) - headroom(a);
      if (rank(a) === 2) return availableAt(a) - availableAt(b);
      return 0;
    },
    remaining: (a, b) => headroom(b) - headroom(a),
    reset: (a, b) => nextReset(a) - nextReset(b),
    plan: (a, b) => planRank(a) - planRank(b),
    name: (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  };
  const compare = cmp[sort];
  // Infinity - Infinity is NaN; `||` turns that (and 0) into the custom-order tie-break.
  return list.slice().sort((a, b) => compare(a, b) || byOrder(a, b));
}

/** Short descriptions of the plan / model-limit filters that are active ("Team", "with fable limit"). */
export function extraFilterLabels(s: ListingSettings): string[] {
  const labels: string[] = [];
  if (s.plan !== "all") labels.push(planName(s.plan));
  if (s.scope !== "any") {
    const [mode, key] = s.scope.split(":");
    labels.push(`${mode === "has" ? "with" : "without"} ${key} limit`);
  }
  return labels;
}

/** True when any filter (not the sort) narrows the list. */
export function filtersActive(s: ListingSettings): boolean {
  return Boolean(s.text) || s.limit !== "all" || extraFilterLabels(s).length > 0;
}
