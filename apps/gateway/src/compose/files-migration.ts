import { getSetting, type PsycheDb, setSetting } from "@psyche/db";

/**
 * "Files on this Mac" was once a connector of its own (an MCP filesystem server with one folder
 * argument). It is now a view onto File access, so the folder it held is granted there and the
 * server entry is removed: one list of folders, no second copy. Read-only, as the safest reading
 * of an old grant; the owner can raise it in Settings. Runs at start, idempotent.
 */

const PACKAGE = "@modelcontextprotocol/server-filesystem";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oldFolders(entry: unknown): string[] | null {
  if (!isRecord(entry) || entry.id !== "filesystem") return null;
  const t = entry.transport;
  if (!isRecord(t) || t.kind !== "stdio" || !Array.isArray(t.command)) return null;
  const cmd = t.command.filter((c): c is string => typeof c === "string");
  const at = cmd.indexOf(PACKAGE);
  if (at < 0) return null;
  return cmd.slice(at + 1).filter((a) => a.startsWith("/") && a !== "/");
}

export function migrateFilesConnector(db: PsycheDb, home: string): { moved: string[] } {
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
    moved.push(...folders.filter((f) => f !== home && !f.startsWith(`${home}/`)));
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
