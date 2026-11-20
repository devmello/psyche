import { describe, expect, it } from "vitest";
import { openDb } from "../src/open.ts";
import { holdSecureDelete, secureDeleteKeyword, withSecureDeleteOn } from "../src/secure-delete.ts";

const setting = (db: ReturnType<typeof openDb>) =>
  db.sqlite.pragma("secure_delete", { simple: true });

describe("secure_delete holds", () => {
  it("restores by keyword: FAST stays FAST, OFF stays OFF, ON stays ON", () => {
    expect(secureDeleteKeyword(0)).toBe("OFF");
    expect(secureDeleteKeyword(1)).toBe("ON");
    expect(secureDeleteKeyword(2)).toBe("FAST");
    const db = openDb(":memory:");
    expect(setting(db)).toBe(2);
    withSecureDeleteOn(db.sqlite, () => expect(setting(db)).toBe(1));
    expect(setting(db)).toBe(2);
    for (const [from, to] of [
      ["OFF", 0],
      ["ON", 1],
    ] as const) {
      db.sqlite.pragma(`secure_delete = ${from}`);
      withSecureDeleteOn(db.sqlite, () => expect(setting(db)).toBe(1));
      expect(setting(db)).toBe(to);
    }
    db.close();
  });

  it("overlapping holds keep ON until the last one is released, in any order", () => {
    const db = openDb(":memory:");
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const releases = [holdSecureDelete(db.sqlite), holdSecureDelete(db.sqlite)];
      expect(setting(db)).toBe(1);
      releases[order[0] as number]?.();
      expect(setting(db)).toBe(1);
      releases[order[1] as number]?.();
      expect(setting(db)).toBe(2);
    }
    // A release called twice counts once.
    const a = holdSecureDelete(db.sqlite);
    const b = holdSecureDelete(db.sqlite);
    a();
    a();
    expect(setting(db)).toBe(1);
    b();
    expect(setting(db)).toBe(2);
    db.close();
  });

  it("a connection that cannot be read gets a no-op release", () => {
    const broken = {
      pragma() {
        throw new Error("closed");
      },
    };
    expect(() => holdSecureDelete(broken)()).not.toThrow();
  });
});
