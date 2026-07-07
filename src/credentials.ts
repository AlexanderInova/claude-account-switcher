import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { writeFileAtomic } from "./atomicWrite";
import { CredentialsFile, OAuthCreds } from "./types";

/**
 * Reads and writes the Claude Code credentials file (~/.claude/.credentials.json).
 * Deploying an account = writing that account's tokens here; parking = removing them.
 */
export class CredentialsManager {
  getCredentialsPath(): string {
    const override = vscode.workspace
      .getConfiguration("claudeSwitcher")
      .get<string>("credentialsPath", "")
      .trim();
    if (override) {
      return override;
    }
    return path.join(os.homedir(), ".claude", ".credentials.json");
  }

  exists(): boolean {
    try {
      return fs.existsSync(this.getCredentialsPath());
    } catch {
      return false;
    }
  }

  /** mtime of the credentials file (0 if missing) — cheap change detection. */
  mtimeMs(): number {
    try {
      return fs.statSync(this.getCredentialsPath()).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Returns the claudeAiOauth object from the file, or null if missing/invalid. */
  readCurrent(): OAuthCreds | null {
    const p = this.getCredentialsPath();
    try {
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as Partial<CredentialsFile>;
      const oauth = parsed.claudeAiOauth;
      if (oauth && typeof oauth.accessToken === "string") {
        return oauth as OAuthCreds;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Returns the full file contents (to preserve any extra fields). */
  private readRawFile(): CredentialsFile | null {
    try {
      const raw = fs.readFileSync(this.getCredentialsPath(), "utf8");
      return JSON.parse(raw) as CredentialsFile;
    } catch {
      return null;
    }
  }

  /**
   * Writes creds to the file atomically (tmp -> rename), preserving any other
   * fields that were already present.
   */
  writeCreds(creds: OAuthCreds): void {
    const p = this.getCredentialsPath();
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });

    const existing = this.readRawFile() ?? ({} as CredentialsFile);
    const next: CredentialsFile = { ...existing, claudeAiOauth: creds };
    this.atomicWrite(p, JSON.stringify(next, null, 2));
  }

  /**
   * Removes the claudeAiOauth block (signs the local Claude Code out) while
   * preserving any other fields. No-op if the file is missing.
   */
  clearLocal(): void {
    const p = this.getCredentialsPath();
    const existing = this.readRawFile();
    if (!existing) {
      return;
    }
    const next = { ...existing } as Partial<CredentialsFile>;
    delete next.claudeAiOauth;
    this.atomicWrite(p, JSON.stringify(next, null, 2));
  }

  private atomicWrite(p: string, json: string): void {
    writeFileAtomic(p, json);
  }
}
