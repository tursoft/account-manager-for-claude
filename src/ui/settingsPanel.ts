import * as vscode from "vscode";
import { checkSettingValue, SETTINGS_PREFIX, SettingSchema, settingsSections, storedValue } from "../settingsModel";

/** What the settings page needs from the extension. */
export interface SettingsDeps {
  /** The contributed settings (package.json `contributes.configuration.properties`). */
  properties: Record<string, SettingSchema>;
  getConfig: () => vscode.WorkspaceConfiguration;
  /** For "Open in VS Code Settings", which shows this extension's settings (`@ext:<id>`). */
  extensionId: string;
}

/**
 * Full-page settings: every setting of the extension in sections, written to the user settings
 * as soon as it changes. One instance; showing it again reveals the open page.
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, deps: SettingsDeps): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "accountManagerForClaude.settings",
      "Account Manager settings",
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
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, deps);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly deps: SettingsDeps
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
    panel.webview.html = this.html(extensionUri);
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg), undefined, this.disposables);
    // Changes made elsewhere (settings.json, VS Code's settings, the analytics page) show here too.
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("accountManagerForClaude")) {
          this.postState();
        }
      },
      undefined,
      this.disposables
    );
  }

  private async onMessage(msg: { type?: string; key?: unknown; value?: unknown }): Promise<void> {
    const key = typeof msg.key === "string" ? msg.key : "";
    const schema = this.schemaOf(key);
    switch (msg.type) {
      case "ready":
        this.postState();
        break;
      case "set":
      case "reset": {
        if (!schema) {
          return;
        }
        let value: unknown; // undefined removes the user's value: the default applies again
        if (msg.type === "set") {
          const checked = checkSettingValue(schema, msg.value);
          if (!checked.ok) {
            void this.panel.webview.postMessage({ type: "error", key, message: checked.error });
            return;
          }
          value = storedValue(schema, checked.value);
        }
        try {
          await this.deps.getConfig().update(key, value, vscode.ConfigurationTarget.Global);
          // The configuration listener sends the new values to the page.
          void this.panel.webview.postMessage({ type: "saved", key, reset: value === undefined });
        } catch (e) {
          void this.panel.webview.postMessage({ type: "error", key, message: `Not saved: ${(e as Error).message}` });
          this.postState(); // put the control back to the stored value
        }
        break;
      }
      case "openVsSettings":
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          schema ? SETTINGS_PREFIX + key : `@ext:${this.deps.extensionId}`
        );
        break;
    }
  }

  private schemaOf(key: string): SettingSchema | undefined {
    return Object.prototype.hasOwnProperty.call(this.deps.properties, SETTINGS_PREFIX + key)
      ? this.deps.properties[SETTINGS_PREFIX + key]
      : undefined;
  }

  /**
   * Every setting with the value the page edits (the user's own, else the default) and a
   * workspace value that overrides it here, if any.
   */
  private postState(): void {
    const config = this.deps.getConfig();
    const sections = settingsSections(this.deps.properties).map((section) => ({
      ...section,
      fields: section.fields.map((field) => {
        const values = config.inspect(field.key);
        return {
          ...field,
          value: values?.globalValue ?? values?.defaultValue ?? field.schema.default,
          modified: values?.globalValue !== undefined,
          workspaceValue: values?.workspaceFolderValue ?? values?.workspaceValue,
        };
      }),
    }));
    void this.panel.webview.postMessage({ type: "state", sections });
  }

  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join("");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", "settings.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "settings.css"));
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
  <title>Account Manager settings</title>
</head>
<body>
  <header class="page-head">
    <div>
      <h1>Account Manager settings</h1>
      <p class="sub">Changes are saved to your user settings right away.</p>
    </div>
    <button id="vsSettingsBtn" class="ghost" type="button"
      title="The same settings in VS Code's Settings editor, where you can also set them for this workspace only">Open in VS Code Settings</button>
  </header>

  <main id="sections" class="sections"></main>

  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    SettingsPanel.current = undefined;
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
  }
}
