import * as fs from "fs";
import * as path from "path";
import { UsageSnapshot } from "./types";

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

const DAY_MS = 86_400_000;

/**
 * Usage readings on disk: one JSON Lines file per month (`YYYY-MM.jsonl`).
 * Readings that repeat the previous values are skipped (apart from a periodic
 * heartbeat), so collecting every minute stays small; readers treat each
 * account's series as a step function.
 */
export class UsageHistory {
  private readonly last = new Map<string, { key: string; t: number }>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  /** Appends a reading unless it repeats the account's previous one. Returns whether it was written. */
  record(
    id: string,
    snapshot: UsageSnapshot,
    meta: { label?: string; plan?: string } = {},
    now = snapshot.fetchedAt || Date.now()
  ): Promise<boolean> {
    if (snapshot.windows.length === 0) {
      return Promise.resolve(false);
    }
    const point: HistoryPoint = { t: now, id, w: {}, r: {}, n: {} };
    if (meta.label) point.label = meta.label;
    if (meta.plan) point.plan = meta.plan;
    for (const w of snapshot.windows) {
      point.w[w.kind] = w.percent;
      if (w.resetsAt) point.r![w.kind] = w.resetsAt;
      point.n![w.kind] = w.label;
    }

    const key = JSON.stringify([point.w, point.r, point.label, point.plan]);
    const previous = this.last.get(id);
    if (previous && previous.key === key && now - previous.t < HISTORY_HEARTBEAT_MS) {
      return Promise.resolve(false);
    }
    this.last.set(id, { key, t: now });

    const file = this.fileFor(now);
    const line = JSON.stringify(point) + "\n";
    this.writing = this.writing
      .then(async () => {
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.appendFile(file, line, "utf8");
      })
      .catch(() => {
        /* history is best effort; a failed write must not break polling */
      });
    return this.writing.then(() => true);
  }

  /** Readings with `from <= t <= to`, oldest first. */
  async query(from: number, to: number): Promise<HistoryPoint[]> {
    await this.writing;
    const points: HistoryPoint[] = [];
    for (const month of monthsBetween(from, to)) {
      let text: string;
      try {
        text = await fs.promises.readFile(path.join(this.dir, `${month}.jsonl`), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const p = JSON.parse(line) as HistoryPoint;
          if (typeof p.t === "number" && typeof p.id === "string" && p.w && p.t >= from && p.t <= to) {
            points.push(p);
          }
        } catch {
          /* skip a torn or corrupted line */
        }
      }
    }
    return points.sort((a, b) => a.t - b.t);
  }

  /** Deletes month files that ended more than `retentionDays` ago. */
  async prune(retentionDays: number, now = Date.now()): Promise<void> {
    const cutoff = now - Math.max(1, retentionDays) * DAY_MS;
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /^(\d{4})-(\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      const monthEnd = Date.UTC(Number(m[1]), Number(m[2]), 1);
      if (monthEnd < cutoff) {
        await fs.promises.rm(path.join(this.dir, name), { force: true });
      }
    }
  }

  /** Removes every recorded reading. */
  async clear(): Promise<void> {
    await this.writing;
    this.last.clear();
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }

  private fileFor(t: number): string {
    return path.join(this.dir, `${monthKey(t)}.jsonl`);
  }
}

function monthKey(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** `YYYY-MM` keys (UTC) of every month that overlaps [from, to]. */
function monthsBetween(from: number, to: number): string[] {
  const keys: string[] = [];
  const d = new Date(from);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const end = new Date(to);
  while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth())) {
    keys.push(`${y}-${String(m + 1).padStart(2, "0")}`);
    m++;
    if (m === 12) {
      m = 0;
      y++;
    }
  }
  return keys;
}
