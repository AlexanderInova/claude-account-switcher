import * as vscode from "vscode";
import { AccountStore } from "../accountStore";

interface ViewMeter {
  label: string;
  percent: number;
  severity: string;
  resetsAt: string | null;
}

interface ViewAccount {
  id: string;
  label: string;
  email?: string;
  subscriptionType?: string;
  isActive: boolean;
  updatesEnabled: boolean;
  suspendedReason?: "rate-limit" | "invalid-grant";
  suspendedDetail?: string;
  parkedCount: number;
  invalidCount: number;
  inUseByOthers: string[];
  windows: ViewMeter[];
  error?: string;
  errorAt?: number;
  fetchedAt?: number;
  cappedUntil?: number;
  ephemeral?: boolean;
  /** usage frozen: every idle parked token expired; manual ⟳ mints a fresh one */
  autoStale?: boolean;
  /** render inside the collapsed "Paused & unavailable" bottom section */
  bottomGroup?: boolean;
}

/** Sync-backend state for the panel's status bar (folder or server mode). */
export interface SyncUiStatus {
  mode: "folder" | "server";
  /** Server mode without usable keys — unlock required. */
  locked: boolean;
  lockDetail?: string;
  /** Server mode: the server is currently not answering (cache is being served). */
  unreachable: boolean;
  /** Server mode: how old the last successful sync is. */
  lastSyncAgoMs?: number;
  /** Folder mode: the folder carries a .migrated marker pointing at this server. */
  migratedTo?: string;
}

/** Activity bar panel: list of accounts with usage limits and actions. */
export class AccountsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "claudeSwitcher.accountsView";
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: AccountStore,
    private readonly getSyncStatus?: () => SyncUiStatus
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg: { type: string; id?: string }) => {
      switch (msg.type) {
        case "ready":
          this.refresh();
          break;
        case "switch":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.switchAccount", msg.id);
          break;
        case "refresh":
          void vscode.commands.executeCommand("claudeSwitcher.refreshUsage", msg.id);
          break;
        case "refreshAll":
          void vscode.commands.executeCommand("claudeSwitcher.refreshUsage");
          break;
        case "add":
          void vscode.commands.executeCommand("claudeSwitcher.addCurrentAccount");
          break;
        case "remove":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.removeAccount", msg.id);
          break;
        case "rename":
          if (msg.id) void vscode.commands.executeCommand("claudeSwitcher.renameAccount", msg.id);
          break;
        case "togglePause":
          if (msg.id)
            void vscode.commands.executeCommand("claudeSwitcher.toggleAccountUpdates", msg.id);
          break;
        case "undo":
          void vscode.commands.executeCommand("claudeSwitcher.undoSwitch");
          break;
        case "unlock":
          void vscode.commands.executeCommand("claudeSwitcher.serverUnlock");
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
    const accounts: ViewAccount[] = this.store.listViews().map((v) => ({
      id: v.uuid,
      label: v.label,
      email: v.email,
      subscriptionType: v.subscriptionType,
      isActive: v.isActive,
      updatesEnabled: v.updatesEnabled,
      suspendedReason: v.suspended?.reason,
      suspendedDetail: v.suspended?.detail,
      parkedCount: v.parkedCount,
      invalidCount: v.invalidCount,
      inUseByOthers: v.inUseByOthers,
      windows: v.lastUsage?.windows ?? [],
      error: v.lastUsage?.error,
      errorAt: v.lastUsage?.errorAt,
      fetchedAt: v.lastUsage?.fetchedAt,
      cappedUntil: v.lastUsage?.cappedUntil,
      ephemeral: v.ephemeral,
      autoStale: v.autoStale,
      bottomGroup: v.bottomGroup,
    }));

    const warnThreshold = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<number>("warnThresholdPercent", 80);

    const status = this.getSyncStatus?.();
    void this.view.webview.postMessage({
      type: "state",
      accounts,
      warnThreshold,
      sync: {
        enabled: this.store.hasStore(),
        folder: this.store.storeDir(),
        windows: this.store.liveInstances().length,
        mode: status?.mode ?? "folder",
        locked: status?.locked ?? false,
        lockDetail: status?.lockDetail,
        unreachable: status?.unreachable ?? false,
        lastSyncAgoMs: status?.lastSyncAgoMs,
        migratedTo: status?.migratedTo,
      },
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
    <button id="addBtn" class="primary" title="Park the current credential into the pool and sign out here">⛁ Park current credential</button>
    <button id="refreshBtn" title="Refresh usage limits">⟳</button>
  </div>
  <div id="syncBar" class="sub"></div>
  <div id="list"></div>
  <div id="empty" class="hidden">
    <p>No saved accounts.</p>
    <p>Log in to Claude Code, then click <b>"Park current credential"</b> to save it for switching.</p>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
