import { describe, expect, it } from "vitest";
import {
  getDevice,
  getSetting,
  getSettings,
  insertDevice,
  listDevices,
  readGuardOf,
  readGuardOfConnection,
  setReadGuard,
  setSetting,
} from "../src/index.ts";
import { memoryDb } from "./helpers.ts";

/** The read guard the Gateway's security-state seal installs (security-state-integrity §7.1). */

describe("read guard", () => {
  it("is checked before every setting and device read", () => {
    const db = memoryDb();
    let checks = 0;
    setReadGuard(db, { check: () => void checks++ });
    setSetting(db, "a", 1);
    insertDevice(db, {
      id: "d",
      name: "d",
      platform: "macos",
      role: "client",
      publicKey: Buffer.alloc(32),
    });
    getSetting(db, "a");
    getSettings(db);
    getDevice(db, "d");
    listDevices(db);
    expect(checks).toBe(4);
    db.close();
  });

  it("can answer with another value, or none, and a key the file lost", () => {
    const db = memoryDb();
    setSetting(db, "kept", "file");
    setSetting(db, "hidden", "file");
    setReadGuard(db, {
      check: () => undefined,
      setting: (key, stored) =>
        key === "kept"
          ? JSON.stringify("known")
          : key === "lost"
            ? JSON.stringify("known")
            : key === "hidden"
              ? undefined
              : stored,
    });
    expect(getSetting(db, "kept")?.value).toBe("known");
    expect(getSetting(db, "hidden")).toBeUndefined();
    expect(getSetting(db, "lost")?.value).toBe("known");
    expect(getSettings(db, ["kept", "hidden", "lost"])).toEqual({ kept: "known", lost: "known" });
    db.close();
  });

  it("is found by the connection too, and removed with undefined", () => {
    const db = memoryDb();
    const guard = { check: () => undefined, genuine: () => false };
    setReadGuard(db, guard);
    expect(readGuardOfConnection(db.sqlite)).toBe(guard);
    setReadGuard(db, undefined);
    expect(readGuardOf(db)).toBeUndefined();
    db.close();
  });
});
