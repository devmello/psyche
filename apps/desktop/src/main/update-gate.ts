import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * When the updater may run (docs/design/updates-and-install-2026.md §2.3, §2.9).
 *
 * Squirrel.Mac installs a new bundle only if it satisfies the designated requirement (DR) of the
 * app that is running. Psyche's release certificate is self-signed, so that requirement is
 * `identifier "com.psyche.desktop" and certificate leaf = H"<sha1>"`, pinned in
 * deploy/macos/designated-requirements.txt (forge copies it into Contents/Resources). The updater
 * therefore runs only when THIS running app satisfies that pinned requirement. An ad-hoc build, a
 * dev build, a copy signed by someone else's certificate, or an app with no pinned requirement yet
 * never updates itself: Squirrel would refuse the update anyway, and a download would be wasted.
 * (A Developer ID build, the optional "later" path, works the same way with its own pinned line.)
 */

/** The name of the file forge puts in `Psyche.app/Contents/Resources/`. */
export const PINNED_REQUIREMENTS_FILE = "designated-requirements.txt";

/** Still the unfilled template line: no certificate has been generated yet. */
const PLACEHOLDER = "SHA1_OF_PSYCHE_RELEASE_CERT";

/**
 * The requirement for `name` (default "desktop") from the file's text, or undefined when the line
 * is missing or still has the placeholder. Format: `<name><TAB><requirement>`; `#` lines are
 * comments.
 */
export function parsePinnedRequirement(text: string, name = "desktop"): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0 || line.slice(0, tab) !== name) continue;
    const requirement = line.slice(tab + 1).trim();
    if (requirement === "" || requirement.includes(PLACEHOLDER)) return undefined;
    return requirement;
  }
  return undefined;
}

export type GateDecision =
  | { run: true; requirement: string }
  | { run: false; state: "disabled" | "no_keys"; why: string };

export interface GateDeps {
  platform: string;
  isPackaged: boolean;
  /** Embedded release keys (release-keys.ts). */
  keyCount: number;
  /** `Psyche.app` */
  bundlePath: string;
  /** The text of the pinned requirements file, or undefined when it is not in the bundle. */
  readPinned(): string | undefined;
  /** True when the bundle's signature satisfies `requirement` (see `satisfiesRequirement`). */
  satisfies(bundlePath: string, requirement: string): Promise<boolean>;
}

/**
 * Decide whether the updater runs. The order matters for what the audit shows: not a signed
 * release build → "disabled"; a release build but no release key embedded → "no_keys".
 */
export async function evaluateUpdaterGate(d: GateDeps): Promise<GateDecision> {
  if (d.platform !== "darwin") return { run: false, state: "disabled", why: "not macOS" };
  if (!d.isPackaged) return { run: false, state: "disabled", why: "not a packaged app" };
  const pinned = d.readPinned();
  const requirement = pinned === undefined ? undefined : parsePinnedRequirement(pinned);
  if (!requirement) {
    return {
      run: false,
      state: "disabled",
      why: "no pinned designated requirement in this build (no release certificate yet)",
    };
  }
  if (!(await d.satisfies(d.bundlePath, requirement))) {
    return {
      run: false,
      state: "disabled",
      why: "this copy is not signed with the Psyche release certificate (ad-hoc, development or re-signed)",
    };
  }
  if (d.keyCount === 0) {
    return { run: false, state: "no_keys", why: "no release key embedded (security §11)" };
  }
  return { run: true, requirement };
}

const execFileAsync = promisify(execFile);

/**
 * `codesign --verify --strict -R "=<requirement>" <bundle>`: exit 0 when the seal is intact and the
 * signature satisfies the requirement. Any failure (unsigned, ad-hoc, other certificate, tool
 * missing) is false.
 */
export async function satisfiesRequirement(
  bundlePath: string,
  requirement: string,
  run: (file: string, args: string[]) => Promise<unknown> = execFileAsync,
): Promise<boolean> {
  try {
    await run("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, bundlePath]);
    return true;
  } catch {
    return false;
  }
}

/** `…/Psyche.app/Contents/MacOS/Psyche` → `…/Psyche.app` */
export function bundleOfExecutable(exePath: string): string {
  return join(exePath, "..", "..", "..");
}

/** The pinned requirements file inside the running bundle, or undefined when it is missing. */
export function readBundledPinned(resourcesPath: string): string | undefined {
  try {
    return readFileSync(join(resourcesPath, PINNED_REQUIREMENTS_FILE), "utf8");
  } catch {
    return undefined;
  }
}

export type QuarantineResult = "absent" | "removed" | "unknown";

/**
 * A file this app downloaded must not carry `com.apple.quarantine`: macOS would then run
 * Gatekeeper over the new app on its first launch and show "Apple could not verify" at every
 * update. Node's `fetch` does not set the flag, and the app's Info.plist has no
 * LSFileQuarantineEnabled (check-designated-requirements.sh), so it should be absent. This looks
 * anyway, strips it if it is there (the file was just verified against the signed manifest) and
 * returns what it found, for the log and the audit.
 */
export async function inspectQuarantine(
  file: string,
  run: (file: string, args: string[]) => Promise<unknown> = execFileAsync,
): Promise<QuarantineResult> {
  try {
    await run("/usr/bin/xattr", ["-p", "com.apple.quarantine", file]);
  } catch (err) {
    // `xattr -p` exits 1 with "No such xattr" when the attribute is not there.
    const text = `${(err as { stderr?: unknown }).stderr ?? ""}`;
    return /No such xattr/i.test(text) ? "absent" : "unknown";
  }
  try {
    await run("/usr/bin/xattr", ["-d", "com.apple.quarantine", file]);
    return "removed";
  } catch {
    return "unknown";
  }
}
