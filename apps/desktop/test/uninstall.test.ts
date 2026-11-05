import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkUninstall, IPC, REMOTE_REFUSED_CHANNELS } from "../src/lib/ipc.ts";
import {
  DELETE_CONFIRM_WORD,
  planUninstall,
  runUninstall,
  type UninstallDeps,
  UninstallError,
} from "../src/main/uninstall.ts";

/**
 * Everything runs on a temporary HOME with fake launchctl, trash, login item and quit: the real
 * /Applications/Psyche.app, the real com.psyche.gateway agent and the real ~/.psyche are never
 * touched.
 */

let root: string;
let calls: string[];
let deps: UninstallDeps;
let authorized: (string | undefined)[];
let authorizeError: Error | null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "psyche-uninstall-"));
  calls = [];
  authorized = [];
  authorizeError = null;
  const userHome = join(root, "home");
  const lib = (...p: string[]) => join(userHome, "Library", ...p);
  mkdirSync(lib("Application Support", "Psyche"), { recursive: true });
  mkdirSync(lib("Caches", "com.psyche.desktop"), { recursive: true });
  mkdirSync(lib("LaunchAgents"), { recursive: true });
  writeFileSync(lib("LaunchAgents", "com.psyche.gateway.plist"), "<plist/>");
  mkdirSync(join(userHome, ".psyche"), { recursive: true });
  mkdirSync(join(root, "Applications", "Psyche.app", "Contents"), { recursive: true });
  deps = {
    userHome,
    psycheHome: join(userHome, ".psyche"),
    appBundlePath: join(root, "Applications", "Psyche.app"),
    helperAppPath: join(
      root,
      "Applications",
      "Psyche.app",
      "Contents",
      "Resources",
      "PsycheHelper.app",
    ),
    uid: 501,
    exists: (p) => existsSync(p),
    run: async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    trashItem: async (p) => {
      calls.push(`trash ${p}`);
    },
    setOpenAtLogin: (v) => calls.push(`login ${v}`),
    authorizeDelete: async (id) => {
      authorized.push(id);
      if (authorizeError) throw authorizeError;
    },
    quit: () => calls.push("quit"),
  };
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("uninstall plan", () => {
  it("keeps the data folder by default and lists only what exists", () => {
    const plan = planUninstall(deps, false);
    const paths = plan.trash.map((i) => i.path);
    expect(paths).toContain(
      join(deps.userHome, "Library", "LaunchAgents", "com.psyche.gateway.plist"),
    );
    expect(paths).toContain(join(deps.userHome, "Library", "Application Support", "Psyche"));
    expect(paths).not.toContain(deps.psycheHome);
    expect(paths.at(-1)).toBe(deps.appBundlePath);
    // Nothing that does not exist is listed.
    expect(paths.some((p) => p.endsWith("com.psyche.helper.plist"))).toBe(false);
  });

  it("lists the data folder when asked to delete it", () => {
    const plan = planUninstall(deps, true);
    expect(plan.trash.some((i) => i.kind === "data" && i.path === deps.psycheHome)).toBe(true);
  });

  it("refuses a data folder that is the home folder, the root or outside it", () => {
    for (const bad of [deps.userHome, "/", join(root, "elsewhere")]) {
      expect(() => planUninstall({ ...deps, psycheHome: bad }, true)).toThrow(UninstallError);
    }
  });

  it("refuses to trash a bundle that is not Psyche.app", () => {
    mkdirSync(join(root, "Applications", "Other.app"));
    expect(() =>
      planUninstall({ ...deps, appBundlePath: join(root, "Applications", "Other.app") }, false),
    ).toThrow(UninstallError);
  });

  it("an unpackaged build moves no app", () => {
    const plan = planUninstall({ ...deps, appBundlePath: null }, false);
    expect(plan.trash.some((i) => i.kind === "app")).toBe(false);
  });
});

describe("running the uninstall", () => {
  it("keep my data: stops the agent and helper, trashes the app last, never the data, then quits", async () => {
    const res = await runUninstall(deps, { deleteData: false });
    expect(authorized).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(calls[0]).toBe("login false");
    expect(calls).toContain(`/usr/bin/pkill -f ${deps.helperAppPath}`);
    expect(calls).toContain("/bin/launchctl bootout gui/501/com.psyche.gateway");
    expect(calls.some((c) => c === `trash ${deps.psycheHome}`)).toBe(false);
    const trashes = calls.filter((c) => c.startsWith("trash "));
    expect(trashes.at(-1)).toBe(`trash ${deps.appBundlePath}`);
    expect(calls.at(-1)).toBe("quit");
    // The agent is stopped before anything is moved.
    expect(calls.indexOf("/bin/launchctl bootout gui/501/com.psyche.gateway")).toBeLessThan(
      calls.indexOf(trashes[0] as string),
    );
  });

  it("delete my data needs the typed word before anything happens", async () => {
    await expect(runUninstall(deps, { deleteData: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(runUninstall(deps, { deleteData: true, confirm: "delete" })).rejects.toMatchObject(
      { code: "invalid_params" },
    );
    expect(calls).toEqual([]);
    expect(authorized).toEqual([]);
  });

  it("delete my data needs fresh presence, and a refused approval changes nothing", async () => {
    authorizeError = Object.assign(new Error("approval"), { code: "approval_required" });
    await expect(
      runUninstall(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD }),
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(authorized).toEqual([undefined]);
    expect(calls).toEqual([]);
  });

  it("delete my data moves ~/.psyche to the Trash (not removed) once approved", async () => {
    await runUninstall(deps, {
      deleteData: true,
      confirm: DELETE_CONFIRM_WORD,
      approvalId: "apr_1",
    });
    expect(authorized).toEqual(["apr_1"]);
    expect(calls).toContain(`trash ${deps.psycheHome}`);
    // The fake trash moves nothing, so the real folder is still there: nothing ran rm.
    expect(existsSync(deps.psycheHome)).toBe(true);
    expect(calls.at(-1)).toBe("quit");
  });

  it("a Trash failure is reported, the rest still moves, and the app is still quit", async () => {
    const bad = join(deps.userHome, "Library", "Application Support", "Psyche");
    deps.trashItem = async (p) => {
      if (p === bad) throw new Error("denied");
      calls.push(`trash ${p}`);
    };
    const res = await runUninstall(deps, { deleteData: false });
    expect(res.failed.map((f) => f.path)).toEqual([bad]);
    expect(calls).toContain(`trash ${deps.appBundlePath}`);
  });
});

describe("the channels", () => {
  it("are refused in a remote window", () => {
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.appUninstallPlan)).toBe(true);
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.appUninstall)).toBe(true);
  });

  it("validate their payload", () => {
    expect(checkUninstall("c", { deleteData: false })).toEqual({ deleteData: false });
    expect(checkUninstall("c", { deleteData: true, confirm: "DELETE", approvalId: "a" })).toEqual({
      deleteData: true,
      confirm: "DELETE",
      approvalId: "a",
    });
    for (const bad of [null, {}, { deleteData: "yes" }, { deleteData: true, confirm: 5 }]) {
      expect(() => checkUninstall("c", bad), JSON.stringify(bad)).toThrow();
    }
  });
});
