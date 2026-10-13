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
      "accountManagerForClaude.analytics",
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
        if (e.affectsConfiguration("accountManagerForClaude.usageHistory")) {
          void this.postMeta();
        }
      },
      undefined,
      this.disposables
    );
  }

  private async onMessage(msg: { type?: string; from?: unknown; to?: unknown; enabled?: unknown }): Promise<void> {
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
      case "setHistory":
        await this.setCollection(msg.enabled === true);
        break;
    }
  }

  /** Turns usage collection on or off (the user-level setting). */
  private async setCollection(enabled: boolean): Promise<void> {
    try {
      await this.deps.getConfig().update("usageHistory.enabled", enabled, vscode.ConfigurationTarget.Global);
      // The configuration listener sends the new state to the page.
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not change usage collection: ${(e as Error).message}`);
      await this.postMeta(); // put the switch back to the real state
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
    <div class="head-actions">
      <span id="updatedText" class="updated-text" aria-live="polite"></span>
      <button id="refreshBtn" class="icon-btn" type="button" title="Reload the charts now (they also reload every 2 minutes)" aria-label="Refresh">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3"/></svg>
      </button>
      <label class="switch" title="Record every account's limits in the background; readings stay on this computer">
        <input id="collectToggle" type="checkbox" role="switch" />
        <span class="track" aria-hidden="true"></span>
        <span class="switch-text">Collect usage history</span>
      </label>
    </div>
  </header>

  <div id="offNotice" class="notice info hidden">
    <span>Collection is off, so nothing new is being recorded (history collected earlier stays
    available). Turn on <b>Collect usage history</b> above to record every account's limits, once a
    minute by default; readings stay on this computer.</span>
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
        <button data-mode="used" title="How much of each limit was used, in percent">Used %</button>
        <button data-mode="available" title="How much of each limit was still available, in percent">Available %</button>
      </div>
    </div>
    <div class="control">
      <span class="label">Chart</span>
      <select id="chartType" aria-label="Chart type">
        <option value="bar">Bar</option>
        <option value="stacked">Stacked bar</option>
        <option value="line">Line</option>
        <option value="area">Area</option>
      </select>
    </div>
  </section>

  <p id="rangeText" class="range-text"></p>
  <div id="emptyNotice" class="notice info hidden"><span id="emptyText"></span></div>

  <div class="layout">
    <aside class="legend-panel" aria-label="Accounts (legend)">
      <div class="legend-head">
        <span class="label">Accounts</span>
        <span class="legend-actions">
          <button id="allBtn" class="link">All</button>
          <button id="noneBtn" class="link">None</button>
        </span>
      </div>
      <div id="accounts" class="legend-list"></div>
      <p class="legend-hint">Tick an account to show it in every chart; the name has its chart color.</p>
    </aside>
    <div class="chart-column">
      <section id="charts" class="charts"></section>

      <section class="utilization" aria-labelledby="utilTitle">
        <div class="section-head">
          <h2 id="utilTitle">Capacity utilization</h2>
          <p class="caption">How much of the capacity each limit offered was actually used, for the
          selected accounts and period. A 5h limit refills every 5 hours and a weekly limit (Fable
          included) every 7 days: capacity that is not used before the reset is lost.</p>
        </div>
        <div id="utilSummary" class="util-summary"></div>
        <section id="utilCharts" class="charts"></section>

        <div class="section-head period-head">
          <h3 id="periodTitle">By calendar period</h3>
          <p class="caption">The same utilization grouped by period: every Monday in the range
          together, every hour of the day together, or each week or month on its own. Only the
          time an account was watched counts as offered capacity.</p>
          <div class="control">
            <span class="label">Group by</span>
            <div class="seg" id="period" role="radiogroup" aria-label="Period">
              <button data-period="weekday" title="All Mondays together, all Tuesdays together, ...">Weekday</button>
              <button data-period="hour" title="All 09:00 hours together, ...: the daily rhythm">Hour of day</button>
              <button data-period="week" title="Each ISO week on its own">Week</button>
              <button data-period="month" title="Each month on its own">Month</button>
            </div>
          </div>
        </div>
        <section id="periodCharts" class="charts" aria-labelledby="periodTitle"></section>
      </section>
    </div>
  </div>

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
