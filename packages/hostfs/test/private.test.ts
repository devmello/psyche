import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  currentUserSid,
  daclIsOwnerOnly,
  isOwnerOnly,
  readDaclsSddl,
  restrictToOwner,
} from "../src/index.ts";
import { exposeToOthers, OWNER_DIR, OWNER_FILE, privacyOf } from "../src/testing.ts";

describe("@psyche/hostfs/testing", () => {
  it("reports an owner-only file and one exposed to others", () => {
    const dir = mkdtempSync(join(tmpdir(), "psyche-hostfs-"));
    try {
      const f = join(dir, "f");
      writeFileSync(f, "x", { mode: 0o600 });
      restrictToOwner(f);
      expect(privacyOf(f)).toBe(OWNER_FILE);
      exposeToOthers(f);
      expect(privacyOf(f)).toBe(process.platform === "win32" ? "shared" : 0o644);
      const d = join(dir, "d");
      mkdirSync(d);
      restrictToOwner(d);
      expect(privacyOf(d)).toBe(OWNER_DIR);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const ME = "S-1-5-21-1-2-3-1001";

describe("daclIsOwnerOnly (SDDL)", () => {
  it("accepts the current user, SYSTEM and Administrators, inherited or not", () => {
    expect(daclIsOwnerOnly(`D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;FA;;;${ME})`, ME, false)).toBe(
      true,
    );
    expect(daclIsOwnerOnly(`D:PAI(A;;FA;;;${ME})(A;;FA;;;S-1-5-18)`, ME, false)).toBe(true);
    expect(daclIsOwnerOnly(`D:P(A;;FA;;;${ME.toLowerCase()})`, ME, false)).toBe(true);
    // An empty protected DACL lets nobody in.
    expect(daclIsOwnerOnly("D:P", ME, false)).toBe(true);
  });

  it("refuses a NULL DACL, broad groups and other accounts", () => {
    expect(daclIsOwnerOnly("D:NO_ACCESS_CONTROL", ME, false)).toBe(false);
    for (const who of ["WD", "AU", "BU", "S-1-5-11", "S-1-5-21-1-2-3-1002", "AN", "BG"]) {
      expect(daclIsOwnerOnly(`D:(A;;FA;;;${ME})(A;ID;FR;;;${who})`, ME, false), who).toBe(false);
    }
    // What `D:\` hands down: Authenticated Users may modify, Users may read.
    expect(
      daclIsOwnerOnly(
        "D:(A;ID;FA;;;BA)(A;ID;FA;;;SY)(A;ID;0x1301bf;;;AU)(A;ID;0x1200a9;;;BU)",
        ME,
        false,
      ),
    ).toBe(false);
    expect(daclIsOwnerOnly("", ME, false)).toBe(false);
  });

  it("ignores deny entries and, for a file only, inherit-only entries", () => {
    expect(daclIsOwnerOnly(`D:(D;;FA;;;WD)(A;;FA;;;${ME})`, ME, false)).toBe(true);
    expect(daclIsOwnerOnly(`D:(A;;FA;;;${ME})(A;OICIIO;FA;;;WD)`, ME, false)).toBe(true);
    expect(daclIsOwnerOnly(`D:(A;;FA;;;${ME})(A;OICIIO;FA;;;WD)`, ME, true)).toBe(false);
  });

  it("stops at the SACL", () => {
    expect(daclIsOwnerOnly(`D:(A;;FA;;;${ME})S:(AU;SA;FA;;;WD)`, ME, false)).toBe(true);
  });
});

describe("isOwnerOnly / restrictToOwner on this host", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "psyche-hostfs-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")("POSIX: the mode decides", () => {
    const f = join(dir, "k");
    writeFileSync(f, "x", { mode: 0o644 });
    chmodSync(f, 0o644);
    expect(isOwnerOnly(f)).toBe(false);
    expect(restrictToOwner(f)).toBe(true);
    expect(isOwnerOnly(f)).toBe(true);
    const d = join(dir, "d");
    mkdirSync(d, { mode: 0o755 });
    chmodSync(d, 0o755);
    expect(isOwnerOnly(d)).toBe(false);
    restrictToOwner(d);
    expect(isOwnerOnly(d)).toBe(true);
  });

  it.runIf(process.platform === "win32")("Windows: the DACL decides", () => {
    expect(currentUserSid()).toMatch(/^S-1-5-/);
    const f = join(dir, "k");
    writeFileSync(f, "x");
    // A temp folder inherits the profile's DACL: the user, SYSTEM and Administrators.
    expect(isOwnerOnly(f)).toBe(true);
    // Mode bits mean nothing here.
    chmodSync(f, 0o666);
    expect(isOwnerOnly(f)).toBe(true);
    expect(spawnSync("icacls", [f, "/grant", "*S-1-1-0:(R)", "/q"]).status).toBe(0);
    expect(isOwnerOnly(f)).toBe(false);
    expect(restrictToOwner(f)).toBe(true);
    expect(isOwnerOnly(f)).toBe(true);

    const d = join(dir, "d");
    mkdirSync(d);
    expect(spawnSync("icacls", [d, "/grant", "*S-1-5-11:(OI)(CI)(M)", "/q"]).status).toBe(0);
    expect(isOwnerOnly(d)).toBe(false);
    writeFileSync(join(d, "inside"), "x");
    expect(isOwnerOnly(join(d, "inside"))).toBe(false);
    expect(restrictToOwner(d)).toBe(true);
    expect(isOwnerOnly(d)).toBe(true);
    writeFileSync(join(d, "later"), "x");
    expect(isOwnerOnly(join(d, "later"))).toBe(true);
  });

  it.runIf(process.platform === "win32")("Windows: one icacls run reads a folder's tree", () => {
    mkdirSync(join(dir, "vault", "sub"), { recursive: true });
    writeFileSync(join(dir, "vault", "sub", "k"), "x");
    writeFileSync(join(dir, "top"), "x");
    expect(spawnSync("icacls", [join(dir, "top"), "/grant", "*S-1-1-0:(R)", "/q"]).status).toBe(0);
    const sid = currentUserSid() ?? "";
    const entries = readDaclsSddl(`${dir}\\*`);
    expect(entries?.map((e) => e.name).sort()).toEqual(["top", "vault"]);
    const own = (name: string, list = entries) =>
      daclIsOwnerOnly(list?.find((e) => e.name === name)?.sddl ?? "", sid, false);
    expect(own("top")).toBe(false);
    expect(own("vault")).toBe(true);
    const tree = readDaclsSddl(join(dir, "vault"), { recursive: true });
    expect(tree?.map((e) => e.name)).toEqual(["vault", "vault\\sub", "vault\\sub\\k"]);
    expect(own("vault\\sub\\k", tree)).toBe(true);
    expect(readDaclsSddl(join(dir, "missing"))).toBeNull();
  });

  it.runIf(process.platform === "win32")("Windows: an unreadable path is not owner-only", () => {
    expect(() => isOwnerOnly(join(dir, "missing"))).toThrow();
  });
});
