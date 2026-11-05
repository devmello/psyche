import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, type Stats, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Owner-only files and folders (security §14: keys, cards, logs 0600 in 0700 folders).
 *
 * On macOS and Linux that is the mode: no group or other bits. Windows has no modes (`stat` reports
 * 0666 for every writable file), so there it is the DACL: an allow entry may name only the current
 * user, SYSTEM, the Administrators group (the counterparts of root, which can read a 0600 file too)
 * and the owner placeholders (OWNER RIGHTS, CREATOR OWNER). A NULL DACL, `Everyone`, `Users`,
 * `Authenticated Users` (what `D:\` hands down) or any other account is not owner-only. When the DACL
 * cannot be read the answer is no: callers fail closed.
 */

const ICACLS_TIMEOUT_MS = 10_000;

/** Windows tools by absolute path: Git for Windows puts its own `whoami` first on PATH. */
function system32(exe: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", exe);
}

let cachedSid: string | null | undefined;

/** The current user's SID (`S-1-5-21-…`) on Windows, from `whoami /user`; `null` if unknown. */
export function currentUserSid(): string | null {
  if (cachedSid !== undefined) return cachedSid;
  const r = spawnSync(system32("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: ICACLS_TIMEOUT_MS,
  });
  const m = /"(S-1-[0-9-]+)"\s*$/m.exec(r.stdout ?? "");
  cachedSid = m?.[1] ?? null;
  return cachedSid;
}

/** SDDL ACE types that grant access. */
const ALLOW_TYPES = new Set(["A", "OA", "XA", "ZA"]);

/** Trustees that may hold an allow entry besides the current user (SDDL aliases or SIDs). */
const TRUSTED = new Set(["SY", "S-1-5-18", "BA", "S-1-5-32-544", "OW", "S-1-3-4", "CO", "S-1-3-0"]);

/**
 * Whether a DACL in SDDL form (`D:PAI(A;;FA;;;SY)…`, as `icacls /save` writes it) grants access to
 * nobody but `userSid` and the trusted system principals. For a file, inherit-only entries (`IO`)
 * are skipped: they do not apply to it. For a folder they are counted, since they reach what is
 * created inside.
 */
export function daclIsOwnerOnly(sddl: string, userSid: string, directory: boolean): boolean {
  const at = sddl.indexOf("D:");
  if (at < 0) return false;
  let dacl = sddl.slice(at + 2);
  // A SACL (`S:`) may follow; it starts outside every parenthesis.
  let depth = 0;
  for (let i = 0; i < dacl.length; i += 1) {
    const c = dacl[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (depth === 0 && c === "S" && dacl[i + 1] === ":") {
      dacl = dacl.slice(0, i);
      break;
    }
  }
  const flagsEnd = dacl.indexOf("(");
  const flags = flagsEnd < 0 ? dacl : dacl.slice(0, flagsEnd);
  if (flags.includes("NO_ACCESS_CONTROL")) return false;
  const user = userSid.toUpperCase();
  for (const m of dacl.matchAll(/\(([^()]*)\)/g)) {
    const [type = "", aceFlags = "", rights = "", , , trustee = ""] = (m[1] ?? "").split(";");
    if (!ALLOW_TYPES.has(type.toUpperCase())) continue;
    if (!directory && aceFlags.toUpperCase().includes("IO")) continue;
    if (rights === "" || /^0x0+$/i.test(rights)) continue;
    const who = trustee.toUpperCase();
    if (who === user || TRUSTED.has(who)) continue;
    // The built-in Administrator account (RID 500) is written as `LA`.
    if (who === "LA" && user.endsWith("-500")) continue;
    return false;
  }
  return true;
}

/** The DACL of `path` in SDDL form, or `null` when Windows would not give it. */
export function readDaclSddl(path: string): string | null {
  return readDaclsSddl(path)?.[0]?.sddl ?? null;
}

/**
 * DACLs in SDDL form from one `icacls /save` run: `target` may end in a `*` wildcard (the entries
 * of a folder) and `recursive` adds everything below each match. Names are relative to the folder
 * holding `target` (`vault`, `vault\keys`), as icacls writes them. `null` when icacls fails. One
 * process for a whole tree, where `isOwnerOnly` per entry would start one each.
 */
export function readDaclsSddl(
  target: string,
  options: { recursive?: boolean } = {},
): { name: string; sddl: string }[] | null {
  const dir = mkdtempSync(join(tmpdir(), "psyche-acl-"));
  try {
    const out = join(dir, "acl");
    const args = [target, "/save", out, ...(options.recursive === true ? ["/t"] : []), "/q"];
    const r = spawnSync(system32("icacls.exe"), args, {
      windowsHide: true,
      timeout: ICACLS_TIMEOUT_MS * (options.recursive === true ? 6 : 1),
    });
    if (r.status !== 0) return null;
    const lines = readFileSync(out)
      .toString("utf16le")
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/);
    // Pairs of lines: the object's name, then its SDDL.
    const found: { name: string; sddl: string }[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const name = lines[i] ?? "";
      const sddl = lines[i + 1]?.trim() ?? "";
      if (name !== "" && sddl !== "") found.push({ name, sddl });
    }
    return found;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether only the owner can reach `path`: no group or other mode bits on macOS/Linux, a DACL that
 * names only the current user and the system principals on Windows. Pass `st` when the caller has
 * already stat'ed the file (it is not re-read on POSIX).
 */
export function isOwnerOnly(
  path: string,
  st?: Stats,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const info = st ?? statSync(path);
  if (platform !== "win32") return (info.mode & 0o077) === 0;
  const sid = currentUserSid();
  if (sid === null) return false;
  const sddl = readDaclSddl(path);
  return sddl !== null && daclIsOwnerOnly(sddl, sid, info.isDirectory());
}

/**
 * `restrictToOwner` unless `path` already is owner-only (a folder under the user profile inherits
 * an owner-only DACL, so it is left as it is). True when it is owner-only afterwards.
 */
export function ensureOwnerOnly(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isOwnerOnly(path, undefined, platform)) return true;
  return restrictToOwner(path, platform) && isOwnerOnly(path, undefined, platform);
}

/**
 * Makes `path` owner-only: mode 0600 (0700 for a folder) on macOS/Linux; on Windows its DACL is
 * reset and replaced, without inheritance from the parent, by full control for the current user
 * and SYSTEM (a folder hands both down to what is created inside). Returns false when Windows could
 * not apply it; callers that depend on it check with `isOwnerOnly`.
 */
export function restrictToOwner(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const directory = statSync(path).isDirectory();
  if (platform !== "win32") {
    chmodSync(path, directory ? 0o700 : 0o600);
    return true;
  }
  const sid = currentUserSid();
  if (sid === null) return false;
  const inherit = directory ? "(OI)(CI)" : "";
  const opts = { windowsHide: true, timeout: ICACLS_TIMEOUT_MS } as const;
  // `/reset` drops explicit entries for other accounts, which `/grant:r` leaves in place.
  if (spawnSync(system32("icacls.exe"), [path, "/reset", "/q"], opts).status !== 0) return false;
  const r = spawnSync(
    system32("icacls.exe"),
    [path, "/inheritance:r", "/grant:r", `*${sid}:${inherit}F`, `*S-1-5-18:${inherit}F`, "/q"],
    opts,
  );
  return r.status === 0;
}
