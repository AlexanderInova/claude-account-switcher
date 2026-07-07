import * as crypto from "crypto";
import * as fs from "fs";

/** Rename failures that mean atomic replace is impossible (e.g. a single-file bind mount). */
const RENAME_FALLBACK_CODES = new Set(["EXDEV", "EBUSY", "EINVAL", "EPERM", "ENOTSUP", "EACCES"]);

/**
 * Writes `data` to `path` as atomically as the filesystem allows.
 *
 * Normally: write a sibling temp file, then `rename` it over the target (atomic).
 * But when the target is a **bind-mounted single file** (common for sharing
 * ~/.claude/.credentials.json into a devcontainer) you cannot rename over the mount
 * point — `rename` throws EXDEV/EBUSY/EINVAL/EPERM. In that case fall back to an
 * in-place write so the operation still succeeds (slightly less atomic, but the only
 * option). Any other error is rethrown.
 */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, data, { encoding: "utf8", mode });
  } catch {
    // Couldn't even create the temp file (e.g. dir not writable) — try in place directly.
    fs.writeFileSync(path, data, { encoding: "utf8", mode });
    return;
  }
  try {
    fs.renameSync(tmp, path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (!RENAME_FALLBACK_CODES.has(code)) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw e;
    }
    // Rename onto the target isn't possible — write in place, then drop the temp file.
    fs.writeFileSync(path, data, { encoding: "utf8", mode });
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.chmodSync(path, mode);
  } catch {
    /* best-effort (e.g. Windows) */
  }
}
