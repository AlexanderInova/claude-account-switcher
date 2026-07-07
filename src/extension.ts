import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { AccountStore } from "./accountStore";
import { CredentialsManager } from "./credentials";
import { claudeJsonPathFrom, IdentityManager } from "./identity";
import { migrateIfNeeded } from "./migrate";
import { TokenRefresher } from "./oauth";
import { SecretVault } from "./secretVault";
import { SharedStore } from "./store";
import { SwitchService } from "./switchService";
import { AccountView } from "./types";
import { AccountsViewProvider } from "./ui/accountsView";
import { StatusBarController } from "./ui/statusBar";
import { UsagePoller } from "./usage";

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolves the shared-store directory (or null when sync is off / unavailable). */
function resolveStoreDir(credentials: CredentialsManager): string | null {
  const cfg = vscode.workspace.getConfiguration("claudeSwitcher");
  if (cfg.get<boolean>("sync.enabled", true) === false) {
    return null;
  }
  const explicit = cfg.get<string>("sync.folder", "").trim();
  if (explicit) {
    return realpathSafe(explicit);
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const f of folders) {
      const p = path.join(f.uri.fsPath, ".claude-account-switcher");
      try {
        if (fs.existsSync(p)) {
          return realpathSafe(p);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return path.join(path.dirname(credentials.getCredentialsPath()), "account-switcher");
}

export function activate(context: vscode.ExtensionContext): void {
  const credentials = new CredentialsManager();
  const identity = new IdentityManager(() => claudeJsonPathFrom(credentials.getCredentialsPath()));
  const vault = new SecretVault(context.secrets);
  const refresher = new TokenRefresher();
  const instanceId = crypto.randomUUID();

  let store: SharedStore | null = null;
  const dir = resolveStoreDir(credentials);
  if (dir) {
    try {
      const s = new SharedStore(dir);
      s.ensureLayout();
      store = s;
    } catch {
      store = null; // directory not writable — degrade to local-only mode
    }
  }

  const getWorkspaceName = () =>
    vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name ?? "window";

  const accountStore = new AccountStore(
    store,
    credentials,
    identity,
    context.workspaceState,
    instanceId
  );
  const switchService = new SwitchService(
    store,
    vault,
    credentials,
    identity,
    accountStore,
    context.workspaceState
  );
  const statusBar = new StatusBarController(accountStore);
  const viewProvider = new AccountsViewProvider(context.extensionUri, accountStore);

  const refreshUI = () => {
    statusBar.refresh();
    viewProvider.refresh();
  };

  const poller = new UsagePoller(
    store,
    vault,
    refresher,
    credentials,
    accountStore,
    instanceId,
    getWorkspaceName,
    () => vscode.workspace.getConfiguration("claudeSwitcher").get<number>("pollIntervalSeconds", 240),
    () => vscode.workspace.getConfiguration("claudeSwitcher").get<boolean>("autoSuspend", true),
    refreshUI,
    () => switchService.ensureLocalAccountRegistered()
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AccountsViewProvider.viewType, viewProvider),
    statusBar,
    { dispose: () => poller.stop() },
    { dispose: () => poller.disposeInstance() }
  );

  // Watch the store folder so other instances' changes reflect quickly.
  if (store) {
    let debounce: NodeJS.Timeout | undefined;
    const onChange = () => {
      if (debounce) {
        clearTimeout(debounce);
      }
      debounce = setTimeout(() => {
        if (accountStore.reload(Date.now())) {
          refreshUI();
        }
      }, 300);
    };
    const watchers = store.watch(onChange);
    context.subscriptions.push({ dispose: () => watchers.forEach((w) => w.close()) });
  }

  // Startup: migrate, recover an interrupted deploy, render, then poll.
  void (async () => {
    try {
      if (store) {
        await migrateIfNeeded(context, store, vault, credentials, identity);
        await switchService.recoverPendingDeploy();
        await switchService.ensureLocalAccountRegistered();
      }
    } catch (e) {
      console.error("claudeSwitcher: startup migration/recovery failed", e);
    }
    accountStore.reload(Date.now());
    accountStore.recomputeActive();
    refreshUI();
    poller.start();
  })();

  // --- Commands ---

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.addCurrentAccount", async () => {
      const res = await switchService.park();
      if (!res.ok) {
        vscode.window.showWarningMessage(res.message);
        refreshUI();
        return;
      }
      refreshUI();
      const choice = await vscode.window.showInformationMessage(
        res.message,
        "Switch account…",
        "Reload window"
      );
      if (choice === "Switch account…") {
        await vscode.commands.executeCommand("claudeSwitcher.switchAccount");
      } else if (choice === "Reload window") {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.switchAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(accountStore, "Switch to account…"));
      if (!targetId) {
        return;
      }
      const res = await switchService.switchTo(targetId);
      refreshUI();
      if (!res.ok) {
        vscode.window.showWarningMessage(res.message);
      } else if (res.needsReload) {
        await switchService.maybeReload(res.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.refreshUsage", async (id?: string) => {
      if (id) {
        await poller.refreshAccount(id);
      } else {
        await poller.refreshAll();
      }
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.removeAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(accountStore, "Remove account profile…"));
      if (!targetId) {
        return;
      }
      const view = accountStore.listViews().find((v) => v.uuid === targetId);
      const confirm = await vscode.window.showWarningMessage(
        `Remove the profile "${view?.label ?? targetId}"? Parked credentials for it are deleted; accounts deployed in other windows are untouched.`,
        { modal: true },
        "Remove"
      );
      if (confirm === "Remove") {
        await switchService.remove(targetId);
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.renameAccount", async (id?: string) => {
      const targetId = id ?? (await pickAccount(accountStore, "Rename profile…"));
      if (!targetId) {
        return;
      }
      const view = accountStore.listViews().find((v) => v.uuid === targetId);
      const label = await vscode.window.showInputBox({
        title: "New profile name",
        value: view?.label,
        validateInput: (v) => (v.trim().length === 0 ? "Enter a name" : undefined),
      });
      if (label) {
        await switchService.rename(targetId, label.trim());
        refreshUI();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.toggleAccountUpdates", async (id?: string) => {
      const targetId = id ?? (await pickAccount(accountStore, "Pause/resume usage updates…"));
      if (!targetId) {
        return;
      }
      const enabled = await switchService.toggleUpdates(targetId);
      const view = accountStore.listViews().find((v) => v.uuid === targetId);
      vscode.window.showInformationMessage(
        `Usage updates ${enabled ? "resumed" : "paused"} for "${view?.label ?? targetId}".`
      );
      refreshUI();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.undoSwitch", async () => {
      const res = await switchService.undoSwitch();
      refreshUI();
      if (!res.ok) {
        vscode.window.showWarningMessage(res.message);
      } else if (res.needsReload) {
        await switchService.maybeReload(res.message);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeSwitcher.openPanel", () => {
      void vscode.commands.executeCommand("claudeSwitcher.accountsView.focus");
    })
  );

  // React to setting changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSwitcher.pollIntervalSeconds")) {
        poller.restart();
      }
      if (e.affectsConfiguration("claudeSwitcher.warnThresholdPercent")) {
        refreshUI();
      }
      if (
        e.affectsConfiguration("claudeSwitcher.sync.enabled") ||
        e.affectsConfiguration("claudeSwitcher.sync.folder") ||
        e.affectsConfiguration("claudeSwitcher.credentialsPath")
      ) {
        void vscode.window.showInformationMessage(
          "Claude Account Switcher: reload the window to apply the storage/sync change.",
          "Reload window"
        ).then((c) => {
          if (c === "Reload window") {
            void vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });
      }
    })
  );
}

export function deactivate(): void {
  /* resources are released via context.subscriptions */
}

/** Shared account-picker QuickPick with a usage + availability preview. */
async function pickAccount(store: AccountStore, title: string): Promise<string | undefined> {
  const accounts = store.listViews();
  if (accounts.length === 0) {
    vscode.window.showInformationMessage(
      'No saved accounts. Use "Park current credential" first.'
    );
    return undefined;
  }

  const items = accounts.map((v: AccountView) => {
    const parts: string[] = [];
    const u = v.lastUsage;
    if (typeof u?.sessionPercent === "number") parts.push(`5h: ${u.sessionPercent}%`);
    if (typeof u?.weeklyPercent === "number") parts.push(`7d: ${u.weeklyPercent}%`);
    if (v.suspended) parts.push(v.suspended.reason === "rate-limit" ? "⚠ rate-limited" : "⚠ token invalid");
    if (!v.updatesEnabled) parts.push("⏸ paused");
    parts.push(`${v.parkedCount} parked`);
    if (v.inUseByOthers.length) parts.push(`in use: ${v.inUseByOthers.join(", ")}`);
    return {
      label: (v.isActive ? "$(check) " : "$(account) ") + v.label,
      description: [v.subscriptionType, parts.join("  ·  ")].filter(Boolean).join("  ·  "),
      id: v.uuid,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    title,
    placeHolder: "Select an account",
    matchOnDescription: true,
  });
  return picked?.id;
}
