import * as vscode from "vscode";

/**
 * Copies `text` to the system clipboard from the extension host, which works in every
 * webview (the browser clipboard API is restricted there). Resolves to whether it worked.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await vscode.env.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
