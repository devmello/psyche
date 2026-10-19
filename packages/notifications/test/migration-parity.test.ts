import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notificationsMigrationSql } from "../src/sqlite-store.ts";

/** Statements only: comments may differ between the two copies. */
function ddl(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();
}

describe("notifications DDL", () => {
  it("matches the copy registered in @psyche/db's migration ledger", () => {
    const ledger = readFileSync(
      new URL("../../db/migrations/202610190200_notifications_init.sql", import.meta.url),
      "utf8",
    );
    expect(ddl(notificationsMigrationSql())).toBe(ddl(ledger));
  });
});
