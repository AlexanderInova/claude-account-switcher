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
    const weekly = usage?.weeklyPercent;
    // Show both the 5h session and the weekly limit (e.g. "2% | 44%") so an account
    // that is free on 5h but exhausted weekly is obvious.
    const pctText = formatPercents(session, weekly);
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
    // Warn if EITHER window is near its limit — a full weekly matters as much as a full 5h.
    const highest = Math.max(
      typeof session === "number" ? session : 0,
      typeof weekly === "number" ? weekly : 0
    );
    this.item.backgroundColor =
      highest >= warn ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}

/** " · 2% | 44%" (session | weekly); omits the leading separator when both are absent. */
function formatPercents(session: number | null | undefined, weekly: number | null | undefined): string {
  const hasSession = typeof session === "number";
  const hasWeekly = typeof weekly === "number";
  if (!hasSession && !hasWeekly) {
    return "";
  }
  const s = hasSession ? `${session}%` : "—";
  const w = hasWeekly ? `${weekly}%` : "—";
  return ` · ${s} | ${w}`;
}
