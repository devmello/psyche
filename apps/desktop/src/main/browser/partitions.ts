import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Agent browser partitions (architecture §5, §12; security §6).
 *
 * - `logged-in` tasks use `persist:agent-<name>` (default name `default`), stored on disk.
 * - `clean` tasks use a non-persistent `agent-clean-<random>` partition, one per tab group
 *   (a task and the popups it opens), gone when the app quits.
 *
 * Electron stores `persist:agent-<name>` at `<userData>/Partitions/agent-<name>` and has no
 * per-partition path option (spike 01 gotcha 6). `linkProfileDir` makes that path a symlink to
 * `$PSYCHE_HOME/browser/profiles/<name>` before the session is first created.
 */

export const DEFAULT_PROFILE_NAME = "default";

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function isValidProfileName(name: string): boolean {
  return NAME.test(name);
}

function checkName(name: string): string {
  if (!isValidProfileName(name))
    throw new Error(`invalid browser profile name ${JSON.stringify(name)}`);
  return name;
}

/** `persist:agent-<name>` for the logged-in profile. */
export function loggedInPartition(name: string = DEFAULT_PROFILE_NAME): string {
  return `persist:agent-${checkName(name)}`;
}

/** A fresh in-memory partition for a clean (logged-out) tab group. */
export function cleanPartition(
  random: () => string = () => randomBytes(8).toString("hex"),
): string {
  const suffix = random();
  if (!/^[A-Za-z0-9]{1,64}$/.test(suffix)) throw new Error("invalid clean partition suffix");
  return `agent-clean-${suffix}`;
}

export function isPersistentPartition(partition: string): boolean {
  return partition.startsWith("persist:");
}

export function isAgentPartition(partition: string): boolean {
  return partition.startsWith("persist:agent-") || partition.startsWith("agent-clean-");
}

/** `$PSYCHE_HOME/browser/profiles/<name>`. */
export function profileDir(home: string, name: string = DEFAULT_PROFILE_NAME): string {
  return join(home, "browser", "profiles", checkName(name));
}

/** Where Electron keeps `persist:agent-<name>`. */
export function partitionStoragePath(
  userData: string,
  name: string = DEFAULT_PROFILE_NAME,
): string {
  return join(userData, "Partitions", `agent-${checkName(name)}`);
}

export type LinkResult = "linked" | "exists" | "failed";

/**
 * Best effort: when `<userData>/Partitions/agent-<name>` does not exist yet, creates the profile
 * dir (0700) under `$PSYCHE_HOME` and symlinks the partition path to it. Anything already at the
 * partition path (a real directory from an earlier run, or a link) is left alone. Call it before
 * `session.fromPartition` creates the session.
 */
export function linkProfileDir(
  userData: string,
  home: string,
  name: string = DEFAULT_PROFILE_NAME,
): LinkResult {
  const link = partitionStoragePath(userData, name);
  try {
    lstatSync(link);
    return "exists";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return "failed";
  }
  try {
    const target = profileDir(home, name);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    chmodSync(target, 0o700);
    mkdirSync(join(userData, "Partitions"), { recursive: true, mode: 0o700 });
    symlinkSync(target, link, "dir");
    return "linked";
  } catch {
    return "failed";
  }
}
