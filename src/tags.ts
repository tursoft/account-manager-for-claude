/**
 * User-defined tags on accounts ("work", "client-a", "laptop"). Plain functions with no
 * DOM, Node, or VS Code, so the extension, the webview bundles, and the tests share them.
 */

/** Longest tag kept; longer ones are cut. */
export const MAX_TAG_LENGTH = 32;
/** Most tags kept per account; later ones are dropped. */
export const MAX_TAGS = 12;

/**
 * Cleans a list of tags from the user, storage, or a backup: trims and collapses spaces,
 * cuts long tags, drops empty ones and repeats (ignoring case; the first spelling wins),
 * and keeps at most MAX_TAGS. Anything that is not a string is ignored.
 */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const tag = value.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH).trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_TAGS) break;
  }
  return tags;
}

/** Tags typed as one comma-separated line ("work, client a"). */
export function parseTags(text: string): string[] {
  return normalizeTags(text.split(","));
}

/** The line `parseTags` reads back, for prefilling an input box. */
export function formatTags(tags: string[]): string {
  return tags.join(", ");
}

/** Every tag used by the accounts, once (first spelling wins), sorted A–Z. */
export function allTags(accounts: { tags?: string[] }[]): string[] {
  const byKey = new Map<string, string>();
  for (const a of accounts) {
    for (const tag of normalizeTags(a.tags)) {
      if (!byKey.has(tag.toLowerCase())) byKey.set(tag.toLowerCase(), tag);
    }
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** A stable hue (0–359) for a tag, so the same tag has the same badge color everywhere. */
export function tagHue(tag: string): number {
  let h = 0;
  for (const ch of tag.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 360;
}
