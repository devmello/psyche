import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { protectedRoots } from "../src/compose/protected-paths.ts";

describe("protectedRoots and the release signing key", () => {
  it("never lets a file tool or a granted folder reach the owner's release key", () => {
    const roots = protectedRoots("/h/.psyche");
    expect(roots).toContain(join(homedir(), "psyche-release-signing-key.pem"));
    expect(roots).toContain(join(homedir(), ".psyche-release"));
  });
});
