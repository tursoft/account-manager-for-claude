/**
 * Shapes shared by the usage history store (extension side) and the views that
 * chart it (webview side). No Node imports, so webview bundles can use it.
 */

/**
 * One recorded usage reading of an account. Limits are keyed by window kind
 * (`session`, `weekly_all`, `weekly_fable`, ...).
 */
export interface HistoryPoint {
  /** epoch ms of the reading */
  t: number;
  /** profile id */
  id: string;
  /** profile label at the time (accounts can be renamed or removed later) */
  label?: string;
  /** subscription type at the time */
  plan?: string;
  /** percent used per window kind */
  w: Record<string, number>;
  /** reset time (ISO) per window kind, when known */
  r?: Record<string, string>;
  /** display label per window kind, e.g. "Weekly (Fable)" */
  n?: Record<string, string>;
}

/** Unchanged readings are still written this often, so charts show the account was checked. */
export const HISTORY_HEARTBEAT_MS = 15 * 60_000;
