import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { hasUsableOAuthCreds } from "../credentialValidation";
import { CARRY_MS } from "../historySeries";
import { ListingSettings } from "../listing";
import { requiresProfileReauthorization } from "../oauth";
import { UsageHistory } from "../usageHistory";
import { copyToClipboard } from "./clipboard";

export interface AvailabilityDeps {
  store: AccountStore;
  history: UsageHistory;
  /** The accounts panel's sort and filters, which the calendar starts from. */
  getInitialListing: () => ListingSettings;
  /** Saves a new custom order of the accounts (the same order the accounts panel uses). */
  reorder: (ids: string[]) => Promise<void>;
}

/**
 * Full-page "Availability" calendar: when each account (and each of its limits)
 * was and will be usable, over a week or a single day. One instance.
 */
export class AvailabilityPanel {
  private static current: AvailabilityPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, deps: AvailabilityDeps): void {
    if (AvailabilityPanel.current) {
      AvailabilityPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "accountManagerForClaude.availability",
      "Account availability",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "media"),
          vscode.Uri.joinPath(extensionUri, "dist", "webview"),
        ],
      }
    );
    AvailabilityPanel.current = new AvailabilityPanel(panel, extensionUri, deps);
  }

  /** Usage or accounts changed: an open calendar reloads its range. */
  static notifyChanged(): void {
    void AvailabilityPanel.current?.panel.webview.postMessage({ type: "changed" });
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly deps: AvailabilityDeps
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    panel.webview.html = this.html(extensionUri);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg), undefined, this.disposables);
  }

  private async onMessage(msg: { type?: string; from?: unknown; to?: unknown; id?: unknown; ids?: unknown }): Promise<void> {
    switch (msg.type) {
      case "ready":
        // Start from the accounts panel's sort and filters; the page keeps its own from here on.
        void this.panel.webview.postMessage({ type: "init", listing: this.deps.getInitialListing() });
        break;
      case "range": {
        const from = Number(msg.from);
        const to = Number(msg.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
          return;
        }
        const now = Date.now();
        const points = from < now ? await this.deps.history.query(from - CARRY_MS, Math.min(to, now)) : [];
        void this.panel.webview.postMessage({
          type: "data",
          from,
          to,
          now,
          points,
          accounts: await this.accounts(),
        });
        break;
      }
      case "reorder":
        if (Array.isArray(msg.ids) && msg.ids.every((id) => typeof id === "string")) {
          await this.deps.reorder(msg.ids as string[]);
        }
        break;
      case "copyName": {
        // Double-click on an account's name.
        const name = typeof msg.id === "string" ? this.deps.store.get(msg.id)?.label : undefined;
        if (name) {
          const ok = await copyToClipboard(name);
          void this.panel.webview.postMessage({ type: "copied", name, ok });
        }
        break;
      }
      case "switch":
        if (typeof msg.id === "string") {
          void vscode.commands.executeCommand("accountManagerForClaude.switchAccount", msg.id);
        }
        break;
    }
  }

  /** Saved accounts in panel order with their latest usage. */
  private async accounts() {
    const activeId = this.deps.store.getActiveId();
    return Promise.all(
      this.deps.store.list().map(async (p) => {
        const creds = await this.deps.store.getCreds(p.id);
        return {
          id: p.id,
          label: p.label,
          subscriptionType: p.subscriptionType,
          isActive: p.id === activeId,
          windows: p.lastUsage?.windows ?? [],
          fetchedAt: p.lastUsage?.fetchedAt,
          needsReauthorization:
            !hasUsableOAuthCreds(creds) ||
            this.deps.store.isRefreshTokenDead(p.id, creds?.refreshToken) ||
            requiresProfileReauthorization(p.lastUsage?.error),
        };
      })
    );
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join("");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "availability.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "availability.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${style}" rel="stylesheet" />
  <title>Account availability</title>
</head>
<body>
  <header class="page-head">
    <div>
      <h1>Account availability</h1>
      <p class="sub">When each account and each of its limits can be used. The future is projected from
      the latest reading and reset times.</p>
    </div>
  </header>

  <section class="toolbar">
    <div class="nav">
      <button id="prevBtn" class="icon" title="Previous" aria-label="Previous">‹</button>
      <button id="todayBtn" class="ghost">Today</button>
      <button id="nextBtn" class="icon" title="Next" aria-label="Next">›</button>
      <span id="rangeLabel" class="range-label"></span>
    </div>
    <div class="seg" id="view" role="radiogroup" aria-label="View">
      <button data-view="week">Week</button>
      <button data-view="day">Day</button>
    </div>
    <div class="limit-checks" role="group" aria-label="Limits shown under each account">
      <span class="label">Limits</span>
      <span id="limitChecks" class="checks"></span>
    </div>
    <div class="legend" aria-label="Legend">
      <span><i class="sw free"></i>Available</span>
      <span><i class="sw high"></i>80%+ used</span>
      <span><i class="sw limited"></i>Limited</span>
      <span><i class="sw nodata"></i>No data</span>
      <span><i class="sw free projected"></i>Projected</span>
    </div>
  </section>

  <section class="filters" aria-label="Filter and sort accounts">
    <input id="searchInput" type="text" placeholder="Filter accounts" spellcheck="false" aria-label="Filter accounts" />
    <div class="seg" id="limitFilter" role="radiogroup" aria-label="Limit filter">
      <button data-limit="all" title="All accounts">All</button>
      <button data-limit="available" title="Accounts with all limits below 100%">Available</button>
      <button data-limit="limited" title="Accounts with at least one limit used up">Limited</button>
    </div>
    <select id="planSelect" aria-label="Plan" title="Filter by plan"></select>
    <select id="scopeSelect" aria-label="Model limit" title="Filter by model-specific limit"></select>
    <label class="select"><span class="label">Sort</span><select id="sortSelect"></select></label>
    <button id="clearFilters" class="ghost hidden">Clear filters</button>
  </section>

  <section id="calendar" class="calendar" aria-label="Availability timeline"></section>

  <section class="now-section" aria-labelledby="nowTitle">
    <h2 id="nowTitle" class="section-title">Right now</h2>
    <div id="now" class="now-strip"></div>
  </section>

  <div id="tooltip" class="tooltip hidden" role="tooltip"></div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    AvailabilityPanel.current = undefined;
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }
}
