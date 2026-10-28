import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSignedInOrigins } from "../src/compose/parts.ts";

let home: string | undefined;
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

function write(doc: unknown): string {
  home = mkdtempSync(join(tmpdir(), "psyche-signed-in-"));
  mkdirSync(join(home, "browser"));
  writeFileSync(join(home, "browser", "signed-in.json"), JSON.stringify(doc));
  return home;
}

describe("readSignedInOrigins", () => {
  it("returns the https origins the desktop recorded", () => {
    const h = write({
      sites: [
        { origin: "https://canvas.ucsc.edu", hosts: [] },
        { origin: "http://insecure.example", hosts: [] },
        { origin: "https://x.example/path", hosts: [] },
        { hosts: [] },
      ],
    });
    expect(readSignedInOrigins(h)).toEqual(["https://canvas.ucsc.edu"]);
  });

  it("is empty when the file is missing or broken", () => {
    expect(readSignedInOrigins(join(tmpdir(), "psyche-no-such-home"))).toEqual([]);
    const h = write("nope");
    expect(readSignedInOrigins(h)).toEqual([]);
  });
});
