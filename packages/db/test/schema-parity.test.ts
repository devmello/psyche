import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

describe("drizzle schema mirrors the SQL migrations", () => {
  const db = memoryDb();

  it("covers every table the migrations create", () => {
    const sqlTables = (
      db.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    const drizzleTables = Object.values(schema)
      .map((t) => getTableName(t))
      .sort();
    expect(drizzleTables).toEqual(sqlTables);
  });

  for (const table of Object.values(schema)) {
    const name = getTableName(table);
    it(`${name}: same columns, order, nullability and primary key`, () => {
      const info = db.sqlite.pragma(`table_info(${name})`) as {
        name: string;
        notnull: number;
        pk: number;
      }[];
      const cols = Object.values(getTableColumns(table));
      expect(cols.map((c) => c.name)).toEqual(info.map((c) => c.name));
      for (const col of cols) {
        const sqlCol = info.find((c) => c.name === col.name);
        expect({ col: col.name, notNull: col.notNull, pk: col.primary }).toEqual({
          col: col.name,
          notNull: sqlCol?.notnull === 1,
          pk: (sqlCol?.pk ?? 0) > 0,
        });
      }
    });
  }
});
