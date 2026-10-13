import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { CARRY_MS } from "../historySeries";
import { UsageHistory } from "../usageHistory";

/** What the analytics page needs from the extension. */
export interface AnalyticsDeps {
  store: AccountStore;
  history: UsageHistory;
  getConfig: () => vscode.WorkspaceConfiguration;
}

/**
 * Full-page "Usage analytics" view: charts of the collected usage history.
 * One instance; showing it again reveals the open panel.
 */
export class AnalyticsPanel {
  private static current: AnalyticsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, deps: AnalyticsDeps): void {
    if (AnalyticsPanel.current) {
      AnalyticsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "tursoftClaudeSwitcher.analytics",
      "Usage analytics",
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
    AnalyticsPanel.current = new AnalyticsPanel(panel, extensionUri, deps);
  }

  /** New readings were recorded: let an open page refresh a range that ends now. */
  static notifyNewData(): void {
    void AnalyticsPanel.current?.panel.webview.postMessage({ type: "newData" });
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly deps: AnalyticsDeps
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    panel.webview.html = this.html(extensionUri);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg), undefined, this.disposables);
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("tursoftClaudeSwitcher.usageHistory")) {
          void this.postMeta();
        }
      },
      undefined,
      this.disposables
    );
  }

  private async onMessage(msg: { type?: string; from?: unknown; to?: unknown }): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.postMeta();
        break;
      case "query": {
        const from = Number(msg.from);
        const to = Number(msg.to);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
          return;
        }
        // Readings shortly before the range seed its first values.
        const points = await this.deps.history.query(from - CARRY_MS, to);
        void this.panel.webview.postMessage({ type: "data", from, to, points, accounts: this.accounts() });
        break;
      }
      case "enableHistory":
        await this.deps.getConfig().update("usageHistory.enabled", true, vscode.ConfigurationTarget.Global);
        break;
      case "openSettings":
        void vscode.commands.executeCommand("tursoftClaudeSwitcher.openSettings");
        break;
    }
  }

  /** Saved accounts in panel order (their colors follow this order). */
  private accounts(): { id: string; label: string; plan?: string }[] {
    return this.deps.store.list().map((p) => ({ id: p.id, label: p.label, plan: p.subscriptionType }));
  }

  private async postMeta(): Promise<void> {
    const config = this.deps.getConfig();
    void this.panel.webview.postMessage({
      type: "meta",
      enabled: config.get<boolean>("usageHistory.enabled", false),
      intervalSeconds: config.get<number>("usageHistory.intervalSeconds", 60),
      retentionDays: config.get<number>("usageHistory.retentionDays", 90),
      accounts: this.accounts(),
    });
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join("");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "analytics.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "analytics.css"));
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
  <title>Usage analytics</title>
</head>
<body>
  <header class="page-head">
    <div>
      <h1>Usage analytics</h1>
      <p id="status" class="sub"></p>
    </div>
    <button id="settingsBtn" class="ghost" title="Open extension settings">Settings</button>
  </header>

  <div id="offNotice" class="notice info hidden">
    <span>Usage collection is off, so there is no history to chart yet. Turn it on to record every
    account's limits once a minute (configurable); data stays on this computer.</span>
    <button id="enableBtn" class="primary">Turn on collection</button>
  </div>

  <section class="controls">
    <div class="control">
      <span class="label">Range</span>
      <div class="seg" id="range" role="radiogroup" aria-label="Time range">
        <button data-range="1d">1 day</button>
        <button data-range="1w">1 week</button>
        <button data-range="1m">1 month</button>
        <button data-range="3m">3 months</button>
        <button data-range="all">All</button>
        <button data-range="custom">Custom</button>
      </div>
      <div id="custom" class="custom hidden">
        <input id="fromInput" type="datetime-local" aria-label="From" />
        <span>to</span>
        <input id="toInput" type="datetime-local" aria-label="To" />
      </div>
    </div>
    <div class="control">
      <span class="label">Show</span>
      <div class="seg" id="mode" role="radiogroup" aria-label="Measure">
        <button data-mode="limit" title="Percent of each limit in use at the time">Limit %</button>
        <button data-mode="usage" title="How much of the limit was used in each interval (change from the previous reading)">Usage</button>
      </div>
    </div>
    <div class="control">
      <span class="label">Chart</span>
      <select id="chartType" aria-label="Chart type">
        <option value="line">Line</option>
        <option value="area">Area</option>
        <option value="bar">Bar</option>
        <option value="stacked">Stacked bar</option>
        <option value="pie">Pie</option>
        <option value="doughnut">Doughnut</option>
      </select>
    </div>
  </section>

  <section class="accounts-bar">
    <span class="label">Accounts</span>
    <div id="accounts" class="chips"></div>
    <button id="allBtn" class="link">All</button>
    <button id="noneBtn" class="link">None</button>
  </section>

  <section id="summary" class="summary"></section>
  <div id="emptyNotice" class="notice info hidden"><span id="emptyText"></span></div>
  <section id="charts" class="charts"></section>

  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    AnalyticsPanel.current = undefined;
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }
}
