import * as vscode from "vscode";
import { AccountStore } from "../accountStore";

/**
 * Status bar item: the active account + the 5h window usage %.
 * Clicking opens the quick account switcher.
 */
export class StatusBarController {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly store: AccountStore) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "claudeSwitcher.switchAccount";
    this.item.show();
  }

  refresh(): void {
    const active = this.store.listViews().find((v) => v.isActive);

    if (!active) {
      const ident = this.store.activeIdentity();
      if (ident) {
        this.item.text = `$(account) ${ident.emailAddress ?? "Claude"} (unsaved)`;
        this.item.tooltip = "Logged in but not saved. Click to park or switch accounts.";
      } else {
        this.item.text = "$(account) Claude: no account";
        this.item.tooltip = "Click to add/switch a Claude account";
      }
      this.item.backgroundColor = undefined;
      return;
    }

    const usage = active.lastUsage;
    const session = usage?.sessionPercent;
    const pctText = typeof session === "number" ? ` · ${session}%` : "";
    this.item.text = `$(account) ${active.label}${pctText}`;

    const lines = [`Active Claude account: ${active.label}`];
    if (active.email) {
      lines.push(`  ${active.email}`);
    }
    if (usage) {
      for (const w of usage.windows) {
        lines.push(`  ${w.label}: ${w.percent}%`);
      }
      if (usage.error) {
        lines.push(`  ⚠ ${usage.error}`);
      }
    }
    if (!active.updatesEnabled) {
      lines.push("  ⏸ usage updates paused");
    }
    if (active.suspended) {
      lines.push(
        `  ⚠ updates suspended (${active.suspended.reason === "rate-limit" ? "rate limit" : "token invalid"})`
      );
    }
    lines.push("Click to switch account.");
    this.item.tooltip = lines.join("\n");

    const warn = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<number>("warnThresholdPercent", 80);
    this.item.backgroundColor =
      typeof session === "number" && session >= warn
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
