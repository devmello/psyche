import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ensureQuarantineDir,
  motwUrl,
  setQuarantineAttribute,
  zoneIdentifier,
} from "../../src/main/browser/downloads.ts";

const root = mkdtempSync(join(tmpdir(), "psy-motw-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Mark of the Web (the Windows quarantine)", () => {
  it("writes zone 3 with the page and the file's URL, without credentials or fragments", () => {
    expect(
      zoneIdentifier({
        url: "https://user:pw@dl.example.com/a.exe#frag",
        referrer: "https://example.com/page?q=1",
      }),
    ).toBe(
      "[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://example.com/page?q=1\r\nHostUrl=https://dl.example.com/a.exe\r\n",
    );
    expect(zoneIdentifier(undefined)).toBe("[ZoneTransfer]\r\nZoneId=3\r\n");
    expect(motwUrl("blob:https://x/1")).toBe("about:internet");
    expect(motwUrl("data:text/plain,hi")).toBe("about:internet");
    expect(motwUrl("not a url")).toBe("about:internet");
    expect(motwUrl("")).toBeUndefined();
  });

  it("writes the Zone.Identifier stream on win32 only, and never throws", async () => {
    const writes: [string, string][] = [];
    const writeFile = async (p: string, d: string) => void writes.push([p, d]);
    const source = { url: "https://dl.example.com/f.zip" };
    expect(
      await setQuarantineAttribute("C:\\q\\f.zip", { platform: "win32", writeFile, source }),
    ).toBe(true);
    expect(writes).toEqual([["C:\\q\\f.zip:Zone.Identifier", zoneIdentifier(source)]]);
    const failing = async () => {
      throw new Error("FAT32 has no streams");
    };
    expect(
      await setQuarantineAttribute("C:\\q\\f", { platform: "win32", writeFile: failing }),
    ).toBe(false);
    expect(await setQuarantineAttribute("/q/f", { platform: "linux", writeFile })).toBe(false);
    expect(writes).toHaveLength(1);
  });

  it.runIf(process.platform === "win32")("sets the real stream on NTFS", async () => {
    const f = join(ensureQuarantineDir(join(root, "home")), "file.bin");
    writeFileSync(f, "x");
    expect(
      await setQuarantineAttribute(f, { source: { url: "https://example.com/file.bin" } }),
    ).toBe(true);
    const zone = readFileSync(`${f}:Zone.Identifier`, "utf8");
    expect(zone).toContain("ZoneId=3");
    expect(zone).toContain("HostUrl=https://example.com/file.bin");
    // The file itself is untouched.
    expect(readFileSync(f, "utf8")).toBe("x");
  });
});
