import { describe, expect, it, vi } from "vitest";
import { shareStarterFolders } from "../../src/compose/onboarding-host.ts";

const DOCS = { id: "documents", path: "/Users/ada/Documents" };
const DESK = { id: "desktop", path: "/Users/ada/Desktop" };

function stub(stored: unknown = undefined) {
  return vi.fn(async (method: string) =>
    method === "settings.get" ? { settings: { "permissions.policy": stored } } : {},
  );
}

describe("shareStarterFolders", () => {
  it("writes nothing when nothing was ticked", async () => {
    const call = stub();
    await shareStarterFolders(call, undefined);
    await shareStarterFolders(call, []);
    expect(call).not.toHaveBeenCalled();
  });

  it("adds exactly the ticked folders, read only, in one settings.set", async () => {
    const call = stub({ mode: "ask", folders: [{ path: "/work", mode: "rw" }] });
    await shareStarterFolders(call, [DOCS, DESK]);
    const sets = call.mock.calls.filter((c) => c[0] === "settings.set");
    expect(sets).toHaveLength(1);
    expect(sets[0]?.[1]).toEqual({
      key: "permissions.policy",
      value: {
        mode: "ask",
        folders: [
          { path: "/work", mode: "rw" },
          { path: "/Users/ada/Documents", mode: "ro" },
          { path: "/Users/ada/Desktop", mode: "ro" },
        ],
      },
    });
  });

  it("never downgrades or duplicates a folder that is already shared", async () => {
    const call = stub({ folders: [{ path: DOCS.path, mode: "rw" }] });
    await shareStarterFolders(call, [DOCS]);
    expect(call.mock.calls.some((c) => c[0] === "settings.set")).toBe(false);
  });

  it("ignores anything that is not one of the three folders or not absolute", async () => {
    const call = stub();
    await shareStarterFolders(call, [
      { id: "home", path: "/Users/ada" },
      { id: "documents", path: "~/Documents" },
    ]);
    expect(call).not.toHaveBeenCalled();
  });

  it("a refused write never throws", async () => {
    const call = vi.fn(async (m: string) => {
      if (m === "settings.set") throw new Error("approval_required");
      return { settings: {} };
    });
    await expect(shareStarterFolders(call, [DOCS])).resolves.toBeUndefined();
  });
});
