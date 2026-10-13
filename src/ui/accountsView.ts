import * as vscode from "vscode";
import { AccountStore } from "../accountStore";
import { CurrentAccountState } from "../credentialSync";
import { hasUsableOAuthCreds } from "../credentialValidation";
import { identityLabel } from "../identity";
import { requiresProfileReauthorization } from "../oauth";

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
}

/** Activity bar panel: list of accounts with usage limits and actions. */
export class AccountsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "tursoftClaudeSwitcher.accountsView";
  private view?: vscode.WebviewView;
  private currentSession?: CurrentSessionView;
  private currentWindows?: ViewWindow[];
  private aboutPending = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AccountStore,
    private readonly version: string
  ) {}

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
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: { type: string; id?: string; ids?: string[]; url?: string }) => {
      switch (msg.type) {
        case "loginCurrent":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.login");
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
      });
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.js")
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
  <title>Claude Accounts</title>
</head>
<body>
  <div id="toolbar">
    <button id="addBtn" class="tb-btn primary" title="Save the account Claude Code is logged in with">Save current</button>
    <button id="loginBtn" class="tb-btn" title="Log in to another Claude account in an isolated login (the current account is not touched)">Add</button>
    <span class="spacer"></span>
    <button id="sayHiBtn" class="icon-btn" title="Say Hi on all inactive accounts" aria-label="Say Hi on all inactive accounts"></button>
    <button id="refreshBtn" class="icon-btn" title="Refresh usage limits" aria-label="Refresh usage limits"></button>
    <button id="toolsBtn" class="icon-btn" title="Backup and restore" aria-label="Backup and restore" aria-haspopup="menu"></button>
    <button id="aboutBtn" class="icon-btn" title="About" aria-label="About"></button>
  </div>
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
    <button id="sortBtn" class="icon-btn" title="Sort accounts" aria-label="Sort accounts" aria-haspopup="menu"></button>
    <button id="clearFilters" class="icon-btn" title="Clear filters" aria-label="Clear filters"></button>
  </div>
  <div id="list"></div>
  <div id="noMatch" class="hidden">
    No accounts match the filters. <button id="noMatchClear" class="link-btn">Clear filters</button>
  </div>
  <div id="empty" class="hidden">
    <p class="empty-title">No saved accounts</p>
    <p>Save the account Claude Code is logged in with, or log in to another one.</p>
    <div class="empty-actions">
      <button id="emptyLoginBtn" class="tb-btn">Add account</button>
      <button id="emptyRestoreBtn" class="tb-btn">Restore backup…</button>
    </div>
    <p class="hint">Never use <code>/logout</code> to change accounts: it revokes that login on Anthropic's side.</p>
  </div>
  <div id="session"></div>
  <div id="menu" class="hidden" role="menu"></div>
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
    return "Login was revoked or expired. Reauthorize this profile.";
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
