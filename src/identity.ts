import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomicWrite";
import { OAuthAccountInfo } from "./types";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const USER_AGENT = "claude-code/2.0.14";

/**
 * Reads / writes the `oauthAccount` identity in ~/.claude.json and provides an
 * online fallback that identifies an account from its access token.
 *
 * Writes are strictly additive: we only touch the `oauthAccount` key, preserve
 * every other field, write atomically, and never create the file if it is
 * missing (Claude Code owns it). All writes are best-effort and never throw.
 */
export class IdentityManager {
  constructor(private readonly getClaudeJsonPath: () => string) {}

  /** The logged-in account identity, or null if unknown/unreadable. */
  readLocalIdentity(): OAuthAccountInfo | null {
    try {
      const raw = fs.readFileSync(this.getClaudeJsonPath(), "utf8");
      const parsed = JSON.parse(raw) as { oauthAccount?: OAuthAccountInfo };
      const acc = parsed.oauthAccount;
      if (acc && typeof acc.accountUuid === "string") {
        return acc;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** mtime of ~/.claude.json (0 if missing) — cheap change detection. */
  mtimeMs(): number {
    try {
      return fs.statSync(this.getClaudeJsonPath()).mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Sets (or clears, when `info` is null) the `oauthAccount` in ~/.claude.json.
   * No-op if the file is missing or unparseable. Best-effort; never throws.
   */
  writeLocalIdentity(info: OAuthAccountInfo | null): void {
    const p = this.getClaudeJsonPath();
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
      if (typeof obj !== "object" || obj === null) {
        return;
      }
    } catch {
      return; // never create ~/.claude.json ourselves
    }
    if (info) {
      obj.oauthAccount = info;
    } else {
      delete obj.oauthAccount;
    }
    try {
      writeFileAtomic(p, JSON.stringify(obj, null, 2));
    } catch {
      /* best-effort */
    }
  }

  /**
   * Identifies an account from its access token via the OAuth profile endpoint.
   * The response shape is undocumented, so parsing is defensive. Returns null on
   * any failure (including a rate limit) — callers treat that as "unknown".
   */
  async fetchProfile(accessToken: string): Promise<OAuthAccountInfo | null> {
    try {
      const res = await fetch(PROFILE_URL, {
        method: "GET",
        headers: {
          Authorization: "Bearer " + accessToken,
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as {
        account?: { uuid?: string; email_address?: string; email?: string };
        organization?: { uuid?: string; name?: string };
      };
      const uuid = data.account?.uuid;
      if (!uuid) {
        return null;
      }
      return {
        accountUuid: uuid,
        emailAddress: data.account?.email_address ?? data.account?.email,
        organizationUuid: data.organization?.uuid,
        organizationName: data.organization?.name,
      };
    } catch {
      return null;
    }
  }
}

/** Derives the ~/.claude.json path from the credentials path (sibling of the .claude dir). */
export function claudeJsonPathFrom(credentialsPath: string): string {
  return path.join(path.dirname(path.dirname(credentialsPath)), ".claude.json");
}
