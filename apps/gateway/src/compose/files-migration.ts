import { getSetting, type PsycheDb, setSetting } from "@psyche/db";
import { assertFolderGrantable, type FolderAccessEnv } from "@psyche/permissions";
import { INTERNAL_SETTING_PREFIX } from "../state-version.ts";

/**
 * "Files on this Mac" was once a connector of its own (an MCP filesystem server with one folder
 * argument). It is now a view onto File access, so the folder it held is granted there and the
 * server entry is removed: one list of folders, no second copy. Read-only, as the safest reading
 * of an old grant; the owner can raise it in Settings. Runs once (a marker says so), and only for
 * the entry the old app wrote: a server that came from a shared file, or that Psyche wrote, is
 * never read as one, whatever it is named. Every folder goes through the same check as a folder
 * typed into Settings, and one that fails it is dropped, not granted.
 */

export const FILES_MIGRATED = `${INTERNAL_SETTING_PREFIX}files.migrated`;

const PACKAGE = "@modelcontextprotocol/server-filesystem";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oldFolders(entry: unknown): string[] | null {
  if (!isRecord(entry) || entry.id !== "filesystem") return null;
  // Someone else's server (a shared file's, or Psyche-made) is not the old connector.
  if (entry.bundle !== undefined || entry.madeBy !== undefined) return null;
  const t = entry.transport;
  if (!isRecord(t) || t.kind !== "stdio" || !Array.isArray(t.command)) return null;
  const cmd = t.command.filter((c): c is string => typeof c === "string");
  const at = cmd.indexOf(PACKAGE);
  if (at < 0) return null;
  return cmd.slice(at + 1).filter((a) => a.startsWith("/") && a !== "/");
}

export async function migrateFilesConnector(
  db: PsycheDb,
  home: string,
  env: FolderAccessEnv = { home },
): Promise<{ moved: string[] }> {
  if (getSetting(db, FILES_MIGRATED)?.value === true) return { moved: [] };
  setSetting(db, FILES_MIGRATED, true);
  const raw = getSetting(db, "mcp.servers")?.value;
  if (!Array.isArray(raw)) return { moved: [] };
  const moved: string[] = [];
  const keep: unknown[] = [];
  for (const entry of raw) {
    const folders = oldFolders(entry);
    if (folders === null) {
      keep.push(entry);
      continue;
    }
    for (const f of folders) {
      if (f === home || f.startsWith(`${home}/`)) continue;
      try {
        await assertFolderGrantable(f, env);
        moved.push(f);
      } catch {
        // A sensitive folder is not granted by a migration either.
      }
    }
  }
  if (keep.length === raw.length) return { moved: [] };
  const stored = getSetting(db, "permissions.policy")?.value;
  const policy = isRecord(stored) ? stored : {};
  const existing = Array.isArray(policy.folders) ? (policy.folders as unknown[]) : [];
  const have = new Set(existing.map((f) => (isRecord(f) ? f.path : undefined)));
  const added = [...new Set(moved)]
    .filter((p) => !have.has(p))
    .map((path) => ({ path, mode: "ro" as const }));
  if (added.length > 0)
    setSetting(db, "permissions.policy", { ...policy, folders: [...existing, ...added] });
  setSetting(db, "mcp.servers", keep);
  return { moved };
}
