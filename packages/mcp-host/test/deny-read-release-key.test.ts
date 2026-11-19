import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultDenyRead } from "../src/launcher.ts";

/** The release signing key must not be readable by MCP servers or other sandboxed tools (security §11). */
describe("defaultDenyRead covers the release signing key", () => {
  const deny = defaultDenyRead("/h/.psyche");
  it.each([
    ["the key file the owner generated", join(homedir(), "psyche-release-signing-key.pem")],
    ["a local-signing folder", join(homedir(), ".psyche-release")],
  ])("denies %s", (_name, path) => {
    expect(deny).toContain(path);
  });
  it("keeps the existing credential stores", () => {
    expect(deny).toEqual(
      expect.arrayContaining([join(homedir(), ".ssh"), join(homedir(), ".aws"), "/h/.psyche"]),
    );
  });
  it("does not deny the whole home folder", () => {
    expect(deny).not.toContain(homedir());
  });
});
