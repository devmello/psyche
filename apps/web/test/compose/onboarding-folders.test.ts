import { describe, expect, it, vi } from "vitest";
import { shareStarterFolders } from "../../src/compose/onboarding-host.ts";

const DOCS = { id: "documents", path: "/Users/ada/Documents" };
const DESK = { id: "desktop", path: "/Users/ada/Desktop" };

function stub(stored: unknown = undefined) {
  return vi.fn(async (method: string, _params?: unknown, _opts?: unknown) =>
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

  it("ignores anything that is not one of the three folders", async () => {
    const call = stub();
    await shareStarterFolders(call, [{ id: "home", path: "/Users/ada" }]);
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps a Windows drive path and a UNC path: the Gateway is the gate", async () => {
    const call = stub();
    await shareStarterFolders(call, [
      { id: "documents", path: "C:\\Users\\ada\\Documents" },
      { id: "desktop", path: "\\\\server\\share\\Desktop" },
    ]);
    const set = call.mock.calls.find((c) => c[0] === "settings.set");
    expect(set?.[1]).toMatchObject({
      value: {
        folders: [
          { path: "C:\\Users\\ada\\Documents", mode: "ro" },
          { path: "\\\\server\\share\\Desktop", mode: "ro" },
        ],
      },
    });
  });

  it("does not add a folder that is stored with different case", async () => {
    const call = stub({ folders: [{ path: "/Users/x/documents", mode: "ro" }] });
    await shareStarterFolders(call, [{ id: "documents", path: "/Users/x/Documents" }]);
    expect(call.mock.calls.some((c) => c[0] === "settings.set")).toBe(false);
  });

  it("a write that needs the approval card is not swallowed", async () => {
    const needs = Object.assign(new Error("approval required"), {
      code: "approval_required",
      details: { approvalId: "ap1" },
    });
    const call = vi.fn(async (m: string, _params?: unknown, _opts?: unknown) => {
      if (m === "settings.set") throw needs;
      return { settings: {} };
    });
    await expect(shareStarterFolders(call, [DOCS])).rejects.toBe(needs);
  });

  it("the retry carries the approved approvalId", async () => {
    const call = stub();
    await shareStarterFolders(call, [DOCS], "ap1");
    const set = call.mock.calls.find((c) => c[0] === "settings.set");
    expect(set?.[1]).toMatchObject({ key: "permissions.policy", approvalId: "ap1" });
  });
});
