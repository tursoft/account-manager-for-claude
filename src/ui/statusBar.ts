import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { hasUsableOAuthCreds } from "../credentialValidation";
import { identityLabel } from "../identity";
import { requiresProfileReauthorization } from "../oauth";
import { nameTone, nameToneDescription } from "../tone";
import { ClaudeAuthIdentity } from "../types";

/**
 * Status bar item: the active account + the 5h window usage %, colored like the
 * account's name in the accounts panel.
 * Clicking opens the quick account switcher.
 */
export class StatusBarController {
  private readonly item: vscode.StatusBarItem;
  private unsavedIdentity: ClaudeAuthIdentity | undefined;
  /** Bumped on every refresh, so a slower earlier one cannot overwrite a newer result. */
  private generation = 0;

  constructor(private readonly store: AccountStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "accountManagerForClaude.switchAccount";
    this.item.show();
  }

  /** A logged-in Claude account that is not saved as a profile (or undefined). */
  setUnsavedIdentity(identity: ClaudeAuthIdentity | undefined): void {
    this.unsavedIdentity = identity;
    this.refresh();
  }

  refresh(): void {
    void this.render(++this.generation);
  }

  private async render(generation: number): Promise<void> {
    const activeId = this.store.getActiveId();
    const active = activeId ? this.store.get(activeId) : undefined;

    if (!active) {
      const unsaved = this.unsavedIdentity ? identityLabel(this.unsavedIdentity) : undefined;
      this.item.text = unsaved
        ? `$(account) Claude: ${unsaved} (not saved)`
        : "$(account) Claude: no account";
      this.item.tooltip = unsaved
        ? `Claude Code is logged in as ${unsaved}, which is not saved as a profile. Use "Save current account".`
        : "Click to add/switch a Claude account";
      this.item.backgroundColor = undefined;
      this.item.color = undefined;
      return;
    }

    const usage = active.lastUsage;
    // The same check as the accounts panel: an expired login's usage cannot be trusted.
    const creds = await this.store.getCreds(active.id);
    if (generation !== this.generation) {
      return;
    }
    const needsReauthorization =
      !hasUsableOAuthCreds(creds) ||
      this.store.isRefreshTokenDead(active.id, creds?.refreshToken) ||
      requiresProfileReauthorization(usage?.error);
    const account = { windows: usage?.windows ?? [], needsReauthorization };

    const session = usage?.sessionPercent;
    const pctText = typeof session === "number" ? ` · ${session}%` : "";
    this.item.text = `$(account) ${active.label}${pctText}`;

    const lines = [`Active Claude account: ${active.label}`];
    const why = nameToneDescription(account);
    if (why) {
      lines.push(...why.split("\n").map((line) => `  ${line}`));
    }
    if (usage) {
      for (const w of usage.windows) {
        lines.push(`  ${w.label}: ${w.percent}%`);
      }
      if (usage.error) {
        lines.push(`  ⚠ ${displayUsageError(usage.error)}`);
      }
    }
    lines.push("Click to switch account.");
    this.item.tooltip = lines.join("\n");

    // Colored like the account's name in the panel: green while it can start sessions, even
    // when a model limit such as Fable is used up; red (on the error background) once the 5h
    // or the general weekly limit is used up, since Claude then refuses sessions.
    const tone = nameTone(account);
    this.item.color =
      tone === undefined ? undefined : new vscode.ThemeColor(tone === "ok" ? "charts.green" : "charts.red");
    this.item.backgroundColor =
      tone === "danger" ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}

function displayUsageError(error: string): string {
  return requiresProfileReauthorization(error)
    ? "Login was revoked or expired. Use Auth to reauthorize this profile."
    : error;
}
