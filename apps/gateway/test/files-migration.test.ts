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
  it("moves its folders into the policy (read-only), keeps others, and removes it", async () => {
    const db = openDb(":memory:");
    setSetting(db, "mcp.servers", [fsServer("/Users/me/Documents", "/Users/me/Notes"), other]);
    setSetting(db, "permissions.policy", {
      defaultMode: "ask",
      folders: [{ path: "/Users/me/Documents", mode: "rw" }],
    });
    const r = await migrateFilesConnector(db, "/Users/me/.psyche");
    expect(r.moved).toEqual(["/Users/me/Documents", "/Users/me/Notes"]);
    expect(getSetting(db, "mcp.servers")?.value).toEqual([other]);
    expect(getSetting(db, "permissions.policy")?.value).toEqual({
      defaultMode: "ask",
      folders: [
        { path: "/Users/me/Documents", mode: "rw" }, // an existing grant is never downgraded
        { path: "/Users/me/Notes", mode: "ro" },
      ],
    });
    expect((await migrateFilesConnector(db, "/Users/me/.psyche")).moved).toEqual([]); // idempotent
  });

  it("never grants / or Psyche's own home, and does nothing without the old server", async () => {
    const db = openDb(":memory:");
    setSetting(db, "mcp.servers", [fsServer("/", "/Users/me/.psyche/vault")]);
    await migrateFilesConnector(db, "/Users/me/.psyche");
    expect(getSetting(db, "mcp.servers")?.value).toEqual([]);
    expect(getSetting(db, "permissions.policy")).toBeUndefined();
    const db2 = openDb(":memory:");
    setSetting(db2, "mcp.servers", [other]);
    expect((await migrateFilesConnector(db2, "/h")).moved).toEqual([]);
    expect(getSetting(db2, "mcp.servers")?.value).toEqual([other]);
  });

  it("does not read a shared connector (or a Psyche-made one) named filesystem as the old one", async () => {
    for (const extra of [{ bundle: { hash: `sha256:${"a".repeat(64)}` } }, { madeBy: "psyche" }]) {
      const db = openDb(":memory:");
      const entry = { ...fsServer("/Users/me/Notes"), ...extra };
      setSetting(db, "mcp.servers", [entry]);
      const r = await migrateFilesConnector(db, "/Users/me/.psyche");
      expect(r.moved).toEqual([]);
      expect(getSetting(db, "mcp.servers")?.value).toEqual([entry]);
      expect(getSetting(db, "permissions.policy")).toBeUndefined();
    }
  });

  it("runs once: an entry that appears later is never migrated", async () => {
    const db = openDb(":memory:");
    await migrateFilesConnector(db, "/Users/me/.psyche");
    setSetting(db, "mcp.servers", [fsServer("/Users/me/Notes")]);
    expect((await migrateFilesConnector(db, "/Users/me/.psyche")).moved).toEqual([]);
    expect(getSetting(db, "permissions.policy")).toBeUndefined();
    expect(getSetting(db, "mcp.servers")?.value).toHaveLength(1);
  });

  it("drops a folder that File access would refuse, and grants the rest", async () => {
    const db = openDb(":memory:");
    setSetting(db, "mcp.servers", [fsServer("/Users/me/secret", "/Users/me/Notes")]);
    const r = await migrateFilesConnector(db, "/Users/me/.psyche", {
      home: "/Users/me",
      protectedRoots: ["/Users/me/secret"],
    });
    expect(r.moved).toEqual(["/Users/me/Notes"]);
  });
});
