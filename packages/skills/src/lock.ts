import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SkillInstallSource, SkillManifestDecl, SkillTrust } from "@psyche/protocol";

/**
 * `$PSYCHE_HOME/skills/skills.lock.json`: what the owner approved, pinned by whole-tree hash.
 * It lives outside the workspace, so the agent's `memory` tool cannot forge an approval.
 *
 * - `home:<name>` entries: installed skills (source, resolved commit, tree hash, findings).
 * - `workspace:<name>` entries: owner-approved workspace skills (review design-02: a workspace
 *   `SKILL.md` without a matching entry is a draft and never reaches the prompt).
 */
export const LOCK_VERSION = 1;
export const LOCK_FILE = "skills.lock.json";

export type LockOrigin = SkillInstallSource | { kind: "workspace" };

export interface LockEntry {
  name: string;
  scope: "home" | "workspace";
  origin: LockOrigin;
  /** Git commit the ref resolved to, for git installs. */
  commit?: string;
  version?: string;
  /** `sha256:` whole-tree hash re-verified on every load. */
  treeHash: string;
  trust: SkillTrust;
  approvalId: string;
  approvedAt: string;
  findings: { high: number; warn: number; info: number };
  /** The declared tools, approval kinds and prompt files the owner approved (T2). */
  manifest?: SkillManifestDecl;
  /** Psyche wrote the skill (self-extension); trust stays `unknown`. Absent for everything else. */
  author?: "agent";
}

export interface LockFile {
  version: number;
  skills: Record<string, LockEntry>;
}

export const lockKey = (scope: LockEntry["scope"], name: string) => `${scope}:${name}`;

export function readLock(path: string): LockFile {
  if (!existsSync(path)) return { version: LOCK_VERSION, skills: {} };
  const data = JSON.parse(readFileSync(path, "utf8")) as LockFile;
  if (typeof data !== "object" || data === null || typeof data.skills !== "object") {
    throw new Error(`${path} is not a skills lock file`);
  }
  if (data.version > LOCK_VERSION)
    throw new Error(`${path} has a newer lock format (${data.version})`);
  return data;
}

/** Atomic write (temp file + rename), mode 0600. */
export function writeLock(path: string, lock: LockFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sorted: LockFile = {
    version: LOCK_VERSION,
    skills: Object.fromEntries(Object.entries(lock.skills).sort(([a], [b]) => a.localeCompare(b))),
  };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
