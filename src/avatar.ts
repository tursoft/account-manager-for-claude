import { limitState, ListAccount } from "./listing";

/**
 * The round account icon shared by the accounts panel and the availability calendar:
 * the provider's mark (a white starburst for Claude) on a fill that shows the account's
 * limit state. Plain functions and data, so webview bundles can import them.
 */

/** green = limit left, orange = a limit is used up, gray = not known. */
export const AVATAR_COLORS = {
  available: "#3c9d5d",
  limited: "#d97757",
  unknown: "#7b8087",
} as const;

export type AvatarState = keyof typeof AVATAR_COLORS;

type AvatarAccount = ListAccount & { needsReauthorization?: boolean };

/** An expired login cannot be used, whatever its last usage said, so it counts as not known. */
export function avatarState(acc: AvatarAccount): AvatarState {
  return acc.needsReauthorization ? "unknown" : limitState(acc);
}

/** What the color means, for the icon's tooltip. */
export function avatarDescription(acc: AvatarAccount): string {
  if (acc.needsReauthorization) return "login expired";
  const state = limitState(acc);
  return state === "available" ? "limit available" : state === "limited" ? "limit used up" : "usage unknown";
}

/** The Claude mark: rays of alternating length around the center, as SVG path markup (16x16 box). */
export function starburstGlyph(rays = 12): string {
  let d = "";
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 ? 4.6 : 6.4;
    d += `M${(8 + Math.cos(a) * 1.4).toFixed(2)} ${(8 + Math.sin(a) * 1.4).toFixed(2)}L${(8 + Math.cos(a) * r).toFixed(2)} ${(8 + Math.sin(a) * r).toFixed(2)}`;
  }
  return `<path d="${d}"/>`;
}
