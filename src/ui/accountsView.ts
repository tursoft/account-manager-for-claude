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
}

interface ViewAccount {
  id: string;
  label: string;
  subscriptionType?: string;
  isActive: boolean;
  windows: { label: string; percent: number; severity: string; resetsAt: string | null }[];
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AccountStore
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
    this.refresh();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type: string; id?: string; ids?: string[] }) => {
      switch (msg.type) {
        case "loginCurrent":
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.login");
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
          void vscode.commands.executeCommand("tursoftClaudeSwitcher.refreshUsage");
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
    });

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
        currentSession: this.currentSession,
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
  </div>
  <div id="list"></div>
  <div id="empty" class="hidden">
    <p class="empty-title">No saved accounts</p>
    <p>Save the account Claude Code is logged in with, or log in to another one.</p>
    <div class="empty-actions">
      <button id="emptyLoginBtn" class="tb-btn">Add account</button>
    </div>
    <p class="hint">Never use <code>/logout</code> to change accounts: it revokes that login on Anthropic's side.</p>
  </div>
  <div id="session"></div>
  <div id="menu" class="hidden" role="menu"></div>
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
