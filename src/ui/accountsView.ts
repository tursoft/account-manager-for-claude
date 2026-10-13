import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { CurrentAccountState } from "../credentialSync";
import { hasUsableOAuthCreds } from "../credentialValidation";
import { identityLabel } from "../identity";
import { ListingSettings, normalizeListing } from "../listing";
import { requiresProfileReauthorization } from "../oauth";
import { copyToClipboard } from "./clipboard";

/** The Claude Code login of this window, when it is not one of the saved profiles. */
interface CurrentSessionView {
  status: "unsaved" | "loggedOut";
  label?: string;
  subscriptionType?: string;
  /** Usage limits of the unsaved login, when they could be fetched. */
  windows?: ViewWindow[];
}

/** Links the About sheet may open; anything else from the webview is ignored. */
const ABOUT_LINKS = new Set([
  "https://tursoft.net",
  "mailto:tursoft@gmail.com",
  "https://github.com/tursoft/claude-account-switcher",
  "https://github.com/KrzysztofZander/claude-account-switcher",
]);

interface ViewWindow {
  kind: string;
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
}

interface ViewAccount {
  id: string;
  label: string;
  subscriptionType?: string;
  isActive: boolean;
  windows: ViewWindow[];
  error?: string;
  fetchedAt?: number;
  retryAfter?: number;
  needsReauthorization: boolean;
  /** Which service the account belongs to; only Claude for now. */
  provider: "claude";
}

/** Activity bar panel: list of accounts with usage limits and actions. */
export class AccountsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tursoftClaudeSwitcher.accountsView";
  private view?: vscode.WebviewView;
  private currentSession?: CurrentSessionView;
  private currentWindows?: ViewWindow[];
  private busy = { ids: [] as string[], all: false, session: false };
  private aboutPending = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AccountStore,
    private readonly version: string,
    private readonly memento: vscode.Memento
  ) {}

  private static readonly VIEW_SETTINGS_KEY = "tursoftClaudeSwitcher.viewSettings";
  /** Bumped when settings change outside the panel (a restore), so the panel adopts them. */
  private viewSettingsRev = 0;
  /** The panel's search text; kept in memory only (it is not a saved setting). */
  private searchText = "";

  /** The panel's sort and filters, including the search text, to start another view from. */
  getListingSeed(): ListingSettings {
    return normalizeListing({ ...this.getViewSettings(), text: this.searchText });
  }

  /** Panel choices (sort and filters), kept here so backups can include them. */
  getViewSettings(): Record<string, unknown> {
    return this.memento.get<Record<string, unknown>>(AccountsViewProvider.VIEW_SETTINGS_KEY) ?? {};
  }

  /** Replaces the panel choices (from a restored backup) and pushes them to the panel. */
  async applyViewSettings(settings: Record<string, unknown>): Promise<void> {
    await this.memento.update(AccountsViewProvider.VIEW_SETTINGS_KEY, settings);
    this.viewSettingsRev++;
    this.refresh();
  }

  /** Records the current Claude Code login so an unsaved one can be offered for saving. */
  setCurrentSession(state: CurrentAccountState): void {
    if (state.loggedIn === false) {
      this.currentSession = { status: "loggedOut" };
    } else if (state.loggedIn && !state.ownerId) {
      this.currentSession = {
        status: "unsaved",
        label: state.unsavedIdentity ? identityLabel(state.unsavedIdentity) : undefined,
        subscriptionType: state.subscriptionType,
      };
    } else {
      this.currentSession = undefined;
    }
    if (this.currentSession?.status !== "unsaved") {
      this.currentWindows = undefined;
    }
    this.refresh();
  }

  /** Which accounts are being refreshed, so the panel can show busy indicators. */
  setBusy(ids: string[], all: boolean): void {
    this.busy = { ...this.busy, ids, all };
    this.postBusy();
  }

  /** Whether the unsaved current login's usage is being fetched. */
  setSessionBusy(session: boolean): void {
    this.busy = { ...this.busy, session };
    this.postBusy();
  }

  private postBusy(): void {
    void this.view?.webview.postMessage({ type: "busy", ...this.busy });
  }

  /** Shows a proposal for `kind` in the panel (e.g. after the active account's limit ran out). */
  showProposal(kind: "session" | `weekly_${string}`, automatic: boolean): void {
    void this.view?.webview.postMessage({ type: "propose", kind, automatic });
  }

  /** Usage limits of the unsaved current login, shown like an account's limits. */
  setCurrentUsage(windows: ViewWindow[] | undefined): void {
    this.currentWindows = windows;
    this.refresh();
  }

  /** Opens the About sheet in the panel (once the view is visible). */
  showAbout(): void {
    if (this.view) {
      void this.view.webview.postMessage({ type: "showAbout" });
    } else {
      this.aboutPending = true;
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "media"),
        vscode.Uri.joinPath(this.extensionUri, "dist", "webview"),
      ],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: { type: string; id?: string; ids?: string[]; url?: string; settings?: unknown; text?: unknown; kind?: unknown }) => {
      switch (msg.type) {
        case "copyName": {
          // Double-click on a name: a saved account (by id), or the unsaved current login (no id).
          const name = msg.id ? this.store.get(msg.id)?.label : this.currentSession?.label;
          if (name) {
            void copyToClipboard(name).then((ok) => webviewView.webview.postMessage({ type: "copied", name, ok }));
          }
          break;
        }
        case "loginCurrent":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.login");
          break;
        case "enableTracking":
          void vscode.workspace
            .getConfiguration("tursoftClaudeSwitcher")
            .update("usageHistory.enabled", true, vscode.ConfigurationTarget.Global)
            .then(() => this.refresh());
          break;
        case "backup":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.backupAccounts");
          break;
        case "restore":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.restoreAccounts");
          break;
        case "openLink":
          if (msg.url && ABOUT_LINKS.has(msg.url)) {
            void vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          break;
        case "viewSettings":
          if (typeof msg.text === "string") {
            this.searchText = msg.text;
          }
          if (
            msg.settings &&
            typeof msg.settings === "object" &&
            !Array.isArray(msg.settings) &&
            JSON.stringify(msg.settings) !== JSON.stringify(this.getViewSettings())
          ) {
            void this.memento.update(AccountsViewProvider.VIEW_SETTINGS_KEY, msg.settings);
          }
          break;
        case "reorder":
          if (Array.isArray(msg.ids)) {
            void this.store
              .reorder(msg.ids.filter((id) => typeof id === "string"))
              .then(() => this.refresh());
          }
          break;
        case "ready":
          this.refresh();
          if (this.aboutPending) {
            this.aboutPending = false;
            void webviewView.webview.postMessage({ type: "showAbout" });
          }
          break;
        case "switch":
          if (msg.id) void vscode.commands.executeCommand("tursoftClaudeSwitcher.switchAccount", msg.id);
          break;
        case "openWindow":
          if (msg.id) {
            void vscode.commands.executeCommand("tursoftClaudeSwitcher.openIndependentWindow", msg.id);
          }
          break;
        case "refresh":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.refreshUsage", msg.id);
          break;
        case "refreshAll":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.refreshAll");
          break;
        case "sayHi":
          if (msg.id) void vscode.commands.executeCommand("tursoftClaudeSwitcher.sayHi", msg.id);
          break;
        case "sayHiAll":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.sayHi");
          break;
        case "add":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.addCurrentAccount");
          break;
        case "login":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.addAccount");
          break;
        case "reauthorize":
          if (msg.id) {
            void vscode.commands.executeCommand("tursoftClaudeSwitcher.reauthorizeProfile", msg.id);
          }
          break;
        case "remove":
          if (msg.id) void vscode.commands.executeCommand("tursoftClaudeSwitcher.removeAccount", msg.id);
          break;
        case "rename":
          if (msg.id) void vscode.commands.executeCommand("tursoftClaudeSwitcher.renameAccount", msg.id);
          break;
        case "undo":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.undoSwitch");
          break;
      }
      }
    );

    this.refresh();
  }

  /** Sends the current state to the webview. */
  refresh(): void {
    if (!this.view) {
      return;
    }
    const activeId = this.store.getActiveId();
    const profiles = this.store.list();
    const warnThreshold = vscode.workspace
      .getConfiguration("tursoftClaudeSwitcher")
      .get<number>("warnThresholdPercent", 80);

    void Promise.all(
      profiles.map(async (p): Promise<ViewAccount> => {
        const creds = await this.store.getCreds(p.id);
        const error = p.lastUsage?.error;
        const needsReauthorization =
          !hasUsableOAuthCreds(creds) ||
          this.store.isRefreshTokenDead(p.id, creds?.refreshToken) ||
          requiresProfileReauthorization(error);
        return {
          id: p.id,
          label: p.label,
          subscriptionType: p.subscriptionType,
          isActive: p.id === activeId,
          windows: p.lastUsage?.windows ?? [],
          error: displayUsageError(error, needsReauthorization),
          fetchedAt: p.lastUsage?.fetchedAt,
          retryAfter: p.lastUsage?.retryAfter,
          needsReauthorization,
          provider: "claude",
        };
      })
    ).then((accounts) => {
      void this.view?.webview.postMessage({
        type: "state",
        accounts,
        warnThreshold,
        currentSession: this.currentSession && {
          ...this.currentSession,
          windows: this.currentWindows,
        },
        version: this.version,
        busy: this.busy,
        viewSettings: this.getViewSettings(),
        trackingEnabled: vscode.workspace
          .getConfiguration("tursoftClaudeSwitcher")
          .get<boolean>("usageHistory.enabled", false),
        viewSettingsRev: this.viewSettingsRev,
      });
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "panel.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.css")
    );
    const iconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "icon.png")
    );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
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
  <link href="${styleUri}" rel="stylesheet" />
  <title>MultiAccount</title>
</head>
<body>
  <div id="filters" class="hidden">
    <label class="search">
      <span id="searchIcon"></span>
      <input id="searchInput" type="text" placeholder="Filter accounts" spellcheck="false" aria-label="Filter accounts" />
    </label>
    <div class="segmented" role="radiogroup" aria-label="Limit filter">
      <button data-filter="all" role="radio" title="All accounts">All</button>
      <button data-filter="available" role="radio" title="Accounts with all limits below 100%">Available</button>
      <button data-filter="limited" role="radio" title="Accounts with at least one limit used up">Limited</button>
    </div>
    <button id="moreFiltersBtn" class="icon-btn" title="Filter by plan or model limit" aria-label="Filter by plan or model limit" aria-haspopup="menu"></button>
    <button id="sortBtn" class="icon-btn" title="Sort accounts" aria-label="Sort accounts" aria-haspopup="menu"></button>
    <button id="clearFilters" class="icon-btn" title="Clear filters" aria-label="Clear filters"></button>
  </div>
  <div id="progress" class="progress" role="progressbar" aria-label="Loading"></div>
  <div id="list">
    <div class="skeleton"></div>
    <div class="skeleton"></div>
  </div>
  <div id="noMatch" class="notice info hidden" data-icon="info">
    <span>No accounts match the filters. <button id="noMatchClear" class="link-btn">Clear filters</button></span>
  </div>
  <div id="empty" class="hidden">
    <p class="empty-title">No saved accounts</p>
    <div class="notice info" data-icon="info">
      <span>Save the account Claude Code is logged in with, or log in to another one.</span>
    </div>
    <div class="empty-actions">
      <button id="emptyLoginBtn" class="tb-btn">Add account</button>
      <button id="emptyRestoreBtn" class="tb-btn">Restore backup…</button>
    </div>
    <div class="notice warn" role="note" data-icon="warning">
      <span>Never use <code>/logout</code> to change accounts: it revokes that login on Anthropic's side.</span>
    </div>
  </div>
  <div id="session"></div>
  <div id="trackingNotice" class="notice info hidden" data-icon="info">
    <span>Usage tracking is off. Turn it on to record every account's limits and get the usage and
    capacity analytics. <button id="enableTrackingBtn" class="link-btn">Turn on tracking</button></span>
  </div>
  <div id="stats" class="hidden" aria-label="Account statistics"></div>
  <div id="toolbar">
    <button id="addBtn" class="tb-btn primary" title="Save the account Claude Code is logged in with">Save current</button>
    <button id="loginBtn" class="tb-btn" title="Log in to another Claude account in an isolated login (the current account is not touched)">Add</button>
  </div>
  <div id="proposeBar" class="propose-bar hidden">
    <button id="proposeSessionBtn" class="tb-btn" data-propose="session" title="Pick the account with the most 5h limit available (and a later reset if equal)">Propose account</button>
    <button id="proposeFableBtn" class="tb-btn" data-propose="weekly_fable" title="Pick the account with the most Fable limit available (and a later reset if equal)">Propose for Fable</button>
  </div>
  <div id="proposal" class="proposal hidden" role="status" aria-live="polite"></div>
  <div id="menu" class="hidden" role="menu"></div>
  <div id="toast" class="toast" role="status" aria-live="polite"></div>
  <div id="about" class="hidden" role="dialog" aria-modal="true" aria-labelledby="aboutTitle">
    <div class="about-card">
      <button id="aboutClose" class="icon-btn about-close" title="Close" aria-label="Close"></button>
      <img class="about-logo" src="${iconUri}" alt="" />
      <h2 id="aboutTitle">Tursoft Claude Multi-Account Switcher</h2>
      <p class="about-version">Version <span id="aboutVersion"></span></p>
      <p class="about-desc">Quickly switch between Claude accounts in Claude Code, with live usage limits.</p>
      <dl class="about-meta">
        <dt>Author</dt>
        <dd>Muhammet Turşak</dd>
        <dt>Email</dt>
        <dd><a href="#" data-link="mailto:tursoft@gmail.com">tursoft@gmail.com</a></dd>
        <dt>Website</dt>
        <dd><a href="#" data-link="https://tursoft.net">tursoft.net</a></dd>
        <dt>Source</dt>
        <dd><a href="#" data-link="https://github.com/tursoft/claude-account-switcher">tursoft/claude-account-switcher</a></dd>
      </dl>
      <p class="about-fork">
        Forked from
        <a href="#" data-link="https://github.com/KrzysztofZander/claude-account-switcher">KrzysztofZander/claude-account-switcher</a>
        by Krzysztof Zander. Thanks for the original work!
      </p>
      <p class="about-license">MIT License</p>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function displayUsageError(
  error: string | undefined,
  needsReauthorization: boolean
): string | undefined {
  if (needsReauthorization) {
    return "The saved login expired or was revoked, so usage cannot be read. Reauthorize to use this account again.";
  }
  return error;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
