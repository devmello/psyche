import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Does this app still match the signature it was released with? (docs/design/updates-and-install-2026.md §2.9)
 *
 * With library validation off (the self-signed design), same-user malware that can write inside a
 * user-owned `/Applications/Psyche.app` could swap a dylib in the bundle, and it would then run
 * inside Psyche's process with Psyche's TCC grants and keychain entries. The signature seal covers
 * every file in the bundle, so `codesign --verify --deep --strict` notices the swap. This module
 * runs that check, and the caller turns the TCC-backed features off when it fails.
 *
 * It is a tripwire, not a wall: the verdict is cached for a day in the app's data folder (a full
 * deep verify costs seconds of CPU, so not on every launch), malware that can write the bundle can
 * also write the cache, and a swap done after the check goes unseen until the next one. It catches
 * the common case, a bundle that was modified and left that way.
 *
 * Only an app that CLAIMS the pinned release identity is checked: its designated requirement, read
 * without verifying anything, equals the pinned one. An ad-hoc or development build, or a copy
 * re-signed with another certificate, is "not_release": it has no release identity for a swap to
 * inherit (its TCC grants are its own), and developers keep a working app.
 */

export type Run = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const defaultRun: Run = (file, args) => execFileAsync(file, args, { maxBuffer: 1 << 20 });

export type IntegrityState = "ok" | "blocked" | "not_release";

export interface IntegrityVerdict {
  state: IntegrityState;
  /** True when the answer came from the cache. */
  cached: boolean;
}

export interface IntegrityDeps {
  /** `Psyche.app` */
  bundle: string;
  /** The pinned `desktop` requirement (update-gate.ts `parsePinnedRequirement`). */
  requirement: string;
  /** Where the verdict is cached, in the app's data folder. */
  cacheFile: string;
  appVersion: string;
  /** Changes when the bundle is replaced (`bundleFingerprint`). */
  fingerprint: string;
  now?: () => number;
  run?: Run;
  maxAgeMs?: number;
}

/** A full verify is cached this long. */
export const INTEGRITY_MAX_AGE_MS = 24 * 3600 * 1000;

interface CacheFile {
  version: 1;
  appVersion: string;
  requirement: string;
  fingerprint: string;
  ok: boolean;
  at: number;
}

/** The size and mtime of the seal file: a reinstall or an update changes it. */
export function bundleFingerprint(bundle: string): string {
  try {
    const st = statSync(join(bundle, "Contents", "_CodeSignature", "CodeResources"));
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return "none";
  }
}

/** The requirement the bundle claims, read without verifying it (`codesign -d -r-`). */
export async function claimedRequirement(bundle: string, run: Run = defaultRun): Promise<string> {
  try {
    const { stdout } = await run("/usr/bin/codesign", ["-d", "-r-", bundle]);
    const m = /^designated => (.*)$/m.exec(stdout);
    return m?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** `codesign --verify --deep --strict -R "=<requirement>"`: every nested file matches the seal. */
export async function deepVerify(
  bundle: string,
  requirement: string,
  run: Run = defaultRun,
): Promise<boolean> {
  try {
    await run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "-R",
      `=${requirement}`,
      bundle,
    ]);
    return true;
  } catch {
    return false;
  }
}

function readCache(file: string): CacheFile | undefined {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
    if (v.version !== 1 || typeof v.ok !== "boolean" || typeof v.at !== "number") return undefined;
    return v as CacheFile;
  } catch {
    return undefined;
  }
}

function writeCache(file: string, c: CacheFile): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(c)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // No cache: the next launch verifies again.
  }
}

export async function checkBundleIntegrity(d: IntegrityDeps): Promise<IntegrityVerdict> {
  const run = d.run ?? defaultRun;
  const now = (d.now ?? Date.now)();
  if ((await claimedRequirement(d.bundle, run)) !== d.requirement) {
    return { state: "not_release", cached: false };
  }
  const c = readCache(d.cacheFile);
  const fresh =
    c !== undefined &&
    c.appVersion === d.appVersion &&
    c.requirement === d.requirement &&
    c.fingerprint === d.fingerprint &&
    c.at <= now + 60_000 &&
    now - c.at < (d.maxAgeMs ?? INTEGRITY_MAX_AGE_MS);
  if (fresh) return { state: c.ok ? "ok" : "blocked", cached: true };
  const ok = await deepVerify(d.bundle, d.requirement, run);
  writeCache(d.cacheFile, {
    version: 1,
    appVersion: d.appVersion,
    requirement: d.requirement,
    fingerprint: d.fingerprint,
    ok,
    at: now,
  });
  return { state: ok ? "ok" : "blocked", cached: false };
}

/** The strings of the warning, in the owner's language (the catalogue loads only when needed). */
export interface IntegrityText {
  title: string;
  detail: string;
  blocked: string;
  ok: string;
}

export async function integrityText(systemLocale: string): Promise<IntegrityText> {
  const { createI18n } = await import("@psyche/ui/i18n-core");
  const i18n = createI18n({ locale: systemLocale });
  return {
    title: i18n.t("app.integrity.title"),
    detail: i18n.t("app.integrity.detail"),
    blocked: i18n.t("app.integrity.blocked"),
    ok: i18n.t("app.integrity.ok"),
  };
}
