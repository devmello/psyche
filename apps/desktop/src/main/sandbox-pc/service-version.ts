import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../supervisor-base.ts";

/**
 * Is the installed sandbox PC service older than the one this build ships? A Squirrel update puts
 * a new `psyche-vm-svc.exe` in the app's resources, but the service runs a copy that was made into
 * `%ProgramFiles%\Psyche\vm-service\<SID>\` at install time, and only an elevated install replaces
 * it. This compares the two (`psyche-vm-svc.exe version` prints `{version, protocol}`; the same
 * numbers are in the service's `service_info`), and never elevates by itself.
 */

export interface ServiceVersion {
  version: string;
  /** The control protocol (psyche-win-vm `PROTOCOL_VERSION`); a service that predates it is 1. */
  protocol: number;
}

export type ServiceUpdate =
  | { kind: "current" }
  /** `compatible`: the installed service still speaks the protocol this build's helper does. */
  | { kind: "outdated"; installed: string; bundled: string; compatible: boolean };

/** One JSON line from `psyche-vm-svc version`; null for anything else. */
export function parseServiceVersion(stdout: string): ServiceVersion | null {
  const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  if (line === undefined) return null;
  try {
    const v = JSON.parse(line) as Record<string, unknown>;
    if (typeof v.version !== "string" || v.version === "" || v.version.length > 64) return null;
    const protocol = v.protocol === undefined ? 1 : v.protocol;
    if (typeof protocol !== "number" || !Number.isInteger(protocol) || protocol < 1) return null;
    return { version: v.version, protocol };
  } catch {
    return null;
  }
}

/** Dotted numeric versions (`0.1.0`, `0.2.0-rc1`); a missing part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (s: string): number[] =>
    s
      .split(/[.\-+]/)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isNaN(n) ? 0 : n));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface ServiceAssessment {
  bundled: ServiceVersion;
  /** Null when the installed exe is missing or would not say. */
  installed: ServiceVersion | null;
  bundledHash: string | null;
  installedHash: string | null;
}

/**
 * Outdated when the installed service reports an older version, or the same version but a
 * different file (a rebuild that did not bump the version), or cannot be read at all. A newer
 * installed service (a downgrade) is left alone.
 */
export function assessServiceUpdate(a: ServiceAssessment): ServiceUpdate {
  const { bundled, installed } = a;
  if (installed === null) {
    return a.installedHash === null
      ? { kind: "outdated", installed: "unknown", bundled: bundled.version, compatible: false }
      : { kind: "current" };
  }
  const order = compareVersions(installed.version, bundled.version);
  const differentFile =
    a.bundledHash !== null && a.installedHash !== null && a.bundledHash !== a.installedHash;
  if (order > 0 || (order === 0 && !differentFile)) return { kind: "current" };
  return {
    kind: "outdated",
    installed: installed.version,
    bundled: bundled.version,
    compatible: installed.protocol === bundled.protocol,
  };
}

/** `%ProgramFiles%\Psyche\vm-service\<SID>\psyche-vm-svc.exe`: where `install` copies the exe. */
export function installedServiceExe(sid: string, env: NodeJS.ProcessEnv = process.env): string {
  const programFiles = env.ProgramW6432 ?? env.ProgramFiles ?? "C:\\Program Files";
  return join(programFiles, "Psyche", "vm-service", sid, "psyche-vm-svc.exe");
}

/** `exe version`; null when it cannot run or prints something else. */
export async function readServiceVersion(run: Runner, exe: string): Promise<ServiceVersion | null> {
  try {
    const res = await run(exe, ["version"]);
    return res.code === 0 ? parseServiceVersion(res.stdout) : null;
  } catch {
    return null;
  }
}

/** SHA-256 of a file; null when it cannot be read. */
export function fileSha256(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash("sha256");
    const s = createReadStream(path);
    s.on("data", (c) => hash.update(c));
    s.once("error", () => resolve(null));
    s.once("end", () => resolve(hash.digest("hex")));
  });
}
