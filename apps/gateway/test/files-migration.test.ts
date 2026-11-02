import { getSetting, openDb, setSetting } from "@psyche/db";
import { describe, expect, it } from "vitest";
import { migrateFilesConnector } from "../src/compose/files-migration.ts";

const fsServer = (...folders: string[]) => ({
  id: "filesystem",
  name: "Files on this Mac",
  transport: {
    kind: "stdio",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", ...folders],
  },
});
const other = { id: "time", name: "Time", transport: { kind: "stdio", command: ["uvx", "x"] } };

describe("old Files on this Mac connector → File access grants", () => {
  it("moves its folders into the policy (read-only), keeps others, and removes it", () => {
    const db = openDb(":memory:");
    setSetting(db, "mcp.servers", [fsServer("/Users/me/Documents", "/Users/me/Notes"), other]);
    setSetting(db, "permissions.policy", {
      defaultMode: "ask",
      folders: [{ path: "/Users/me/Documents", mode: "rw" }],
    });
    const r = migrateFilesConnector(db, "/Users/me/.psyche");
    expect(r.moved).toEqual(["/Users/me/Documents", "/Users/me/Notes"]);
    expect(getSetting(db, "mcp.servers")?.value).toEqual([other]);
    expect(getSetting(db, "permissions.policy")?.value).toEqual({
      defaultMode: "ask",
      folders: [
        { path: "/Users/me/Documents", mode: "rw" }, // an existing grant is never downgraded
        { path: "/Users/me/Notes", mode: "ro" },
      ],
    });
    expect(migrateFilesConnector(db, "/Users/me/.psyche").moved).toEqual([]); // idempotent
  });

  it("never grants / or Psyche's own home, and does nothing without the old server", () => {
    const db = openDb(":memory:");
    setSetting(db, "mcp.servers", [fsServer("/", "/Users/me/.psyche/vault")]);
    migrateFilesConnector(db, "/Users/me/.psyche");
    expect(getSetting(db, "mcp.servers")?.value).toEqual([]);
    expect(getSetting(db, "permissions.policy")).toBeUndefined();
    const db2 = openDb(":memory:");
    setSetting(db2, "mcp.servers", [other]);
    expect(migrateFilesConnector(db2, "/h").moved).toEqual([]);
    expect(getSetting(db2, "mcp.servers")?.value).toEqual([other]);
  });
});
