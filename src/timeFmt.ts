// Server-side relative-time helpers for QuickPick labels (the webview has its own
// copies in media/panel.js). Kept tiny and pure so they're unit-testable.

/** "just now" / "3 min ago" / "2h ago" / "5d ago"; "never" when the timestamp is missing. */
export function fmtAgo(ts: number | undefined, now: number = Date.now()): string {
  if (!ts) {
    return "never";
  }
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) {
    return "just now";
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `${m} min ago`;
  }
  const h = Math.floor(s / 3600);
  if (h < 24) {
    const rem = Math.round((s % 3600) / 60);
    return rem ? `${h}h ${rem}m ago` : `${h}h ago`;
  }
  const d = Math.floor(s / 86400);
  return `${d}d ago`;
}

/** "expired" / "expires in 4h" / "expires in 12 min" for an access-token expiry. */
export function fmtExpiry(expiresAt: number | undefined, now: number = Date.now()): string {
  if (!expiresAt) {
    return "expiry unknown";
  }
  const s = Math.round((expiresAt - now) / 1000);
  if (s <= 0) {
    return "expired";
  }
  const m = Math.round(s / 60);
  if (m < 60) {
    return `expires in ${m} min`;
  }
  const h = Math.floor(s / 3600);
  if (h < 24) {
    return `expires in ${h}h`;
  }
  const d = Math.floor(s / 86400);
  return `expires in ${d}d`;
}
