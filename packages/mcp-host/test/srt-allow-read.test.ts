import { describe, expect, it } from "vitest";
import { srtSettings } from "../src/launcher.ts";

/** An agent-made server reads its own directory inside the otherwise denied Psyche home. */
describe("srtSettings allowRead", () => {
  const spec = (allowRead?: string[]) => ({
    serverId: "notes",
    trust: "unknown" as const,
    command: ["node", "server.mjs"],
    env: {},
    serverEnv: {},
    sandbox: {
      allowedDomains: [],
      allowWrite: [],
      denyRead: [],
      ...(allowRead ? { allowRead } : {}),
    },
  });
  it("is empty by default and never grants writes", () => {
    const s = srtSettings(spec(), "/home/.psyche", "/scratch") as {
      filesystem: Record<string, string[]>;
    };
    expect(s.filesystem.allowRead).toEqual([]);
    expect(s.filesystem.allowWrite).toEqual(["/scratch"]);
  });
  it("re-allows the named directory for reading only", () => {
    const dir = "/home/.psyche/agent-connectors/notes";
    const s = srtSettings(spec([dir]), "/home/.psyche", "/scratch") as {
      filesystem: Record<string, string[]>;
    };
    expect(s.filesystem.allowRead).toEqual([dir]);
    expect(s.filesystem.denyRead).toContain("/home/.psyche");
    expect(s.filesystem.allowWrite).toEqual(["/scratch"]);
    expect(s.filesystem.denyWrite).toContain("/home/.psyche");
  });
});
