import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { hasUsableOAuthCreds } from "../credentialValidation";
import { CARRY_MS } from "../historySeries";
import { requiresProfileReauthorization } from "../oauth";
import { UsageHistory } from "../usageHistory";

export interface AvailabilityDeps {
  store: AccountStore;
  history: UsageHistory;
  getConfig: () => vscode.WorkspaceConfiguration;
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
      "tursoftClaudeSwitcher.availability",
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
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    panel.webview.html = this.html(extensionUri);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg), undefined, this.disposables);
  }

  private async onMessage(msg: { type?: string; from?: unknown; to?: unknown; id?: unknown }): Promise<void> {
    switch (msg.type) {
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
          historyEnabled: this.deps.getConfig().get<boolean>("usageHistory.enabled", false),
        });
        break;
      }
      case "switch":
        if (typeof msg.id === "string") {
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.switchAccount", msg.id);
        }
        break;
      case "enableHistory":
        await this.deps.getConfig().update("usageHistory.enabled", true, vscode.ConfigurationTarget.Global);
        AvailabilityPanel.notifyChanged();
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
          plan: p.subscriptionType,
          isActive: p.id === activeId,
          windows: p.lastUsage?.windows ?? [],
          fetchedAt: p.lastUsage?.fetchedAt,
          expired:
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

  <section id="now" class="now-strip" aria-label="Right now"></section>

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
    <label class="toggle"><input id="lanesToggle" type="checkbox" /> Show each limit</label>
    <div class="legend" aria-label="Legend">
      <span><i class="sw free"></i>Available</span>
      <span><i class="sw high"></i>80%+ used</span>
      <span><i class="sw limited"></i>Limited</span>
      <span><i class="sw nodata"></i>No data</span>
      <span><i class="sw free projected"></i>Projected</span>
    </div>
  </section>

  <div id="historyNotice" class="notice hidden">
    <span>Past availability needs collected usage history. Turn it on to fill in the days behind you.</span>
    <button id="enableBtn" class="primary">Turn on collection</button>
  </div>

  <section id="calendar" class="calendar" aria-label="Availability timeline"></section>
  <div id="tooltip" class="tooltip hidden" role="tooltip"></div>

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
