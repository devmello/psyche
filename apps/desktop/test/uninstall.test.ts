import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkUninstall, IPC, REMOTE_REFUSED_CHANNELS } from "../src/lib/ipc.ts";
import {
  DELETE_CONFIRM_WORD,
  dataFolderProblem,
  KEYCHAIN_SERVICES,
  planUninstall,
  psycheHomeFromPlist,
  runUninstall,
  trashProblem,
  type UninstallDeps,
  UninstallError,
} from "../src/main/uninstall.ts";

/**
 * Everything runs on a temporary HOME with fake launchctl, trash, login item, updater and quit:
 * the real /Applications/Psyche.app, the real com.psyche.gateway agent and the real ~/.psyche are
 * never touched.
 */

let root: string;
let userHome: string;
let calls: string[];
let deps: UninstallDeps;
let authorized: { path: string; id: string | undefined }[];
let authorizeError: Error | null;
let loadedPolls: number; // how many more times the agent still reports as loaded
let stagedUpdate: string[];
let confirmAnswer: boolean;
let securityLeft: number;

const lib = (...p: string[]) => join(userHome, "Library", ...p);

function marker(dir: string): void {
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "state", "psyche.sqlite"), "db");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "psyche-uninstall-")));
  calls = [];
  authorized = [];
  authorizeError = null;
  loadedPolls = 0;
  stagedUpdate = [];
  confirmAnswer = true;
  securityLeft = 2;
  userHome = join(root, "home");
  mkdirSync(lib("Application Support", "Psyche"), { recursive: true });
  mkdirSync(lib("Caches", "com.psyche.desktop"), { recursive: true });
  mkdirSync(lib("Saved Application State", "com.psyche.desktop.savedState"), { recursive: true });
  mkdirSync(lib("LaunchAgents"), { recursive: true });
  writeFileSync(lib("LaunchAgents", "com.psyche.gateway.plist"), "<plist/>");
  marker(join(userHome, ".psyche"));
  mkdirSync(join(root, "Applications", "Psyche.app", "Contents"), { recursive: true });
  deps = {
    userHome,
    psycheHome: join(userHome, ".psyche"),
    appBundlePath: join(root, "Applications", "Psyche.app"),
    helperAppPath: join(root, "Applications", "Psyche.app", "Contents", "Resources", "H.app"),
    uid: 501,
    run: async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "/usr/bin/security") {
        securityLeft -= 1;
        return { code: securityLeft >= 0 ? 0 : 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    trashItem: async (p) => {
      calls.push(`trash ${p}`);
    },
    setOpenAtLogin: (v) => calls.push(`login ${v}`),
    agentOwner: () => "ours",
    agentLoaded: async () => {
      calls.push("loaded?");
      if (loadedPolls > 0) {
        loadedPolls -= 1;
        return true;
      }
      return false;
    },
    restartAgent: async () => {
      calls.push("restart");
    },
    clearStagedUpdate: async () => {
      calls.push("stop-updater");
      return stagedUpdate;
    },
    authorizeDelete: async (path, id) => {
      authorized.push({ path, id });
      if (authorizeError) throw authorizeError;
    },
    confirm: async () => confirmAnswer,
    closeWindows: () => calls.push("close-windows"),
    quit: () => calls.push("quit"),
    sleep: async () => undefined,
  };
});

afterEach(() => {
  try {
    chmodSync(lib("Caches"), 0o755);
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

const trashes = () => calls.filter((c) => c.startsWith("trash ")).map((c) => c.slice(6));

describe("the data-folder rules (M4)", () => {
  it("accepts a marked folder strictly inside the home folder", () => {
    expect(dataFolderProblem(join(userHome, ".psyche"), userHome)).toBeNull();
    expect(dataFolderProblem(`${join(userHome, ".psyche")}//`, userHome)).toBeNull();
  });

  it("refuses an empty value, a relative path, the home folder in any spelling, and ancestors", () => {
    for (const bad of [
      undefined,
      "",
      "relative/.psyche",
      userHome,
      `${userHome}//`,
      `${userHome}/.`,
      root,
      "/",
      "/Users",
      "/Applications",
      "/Volumes",
    ]) {
      expect(dataFolderProblem(bad, userHome), String(bad)).not.toBeNull();
    }
  });

  it("refuses the personal folders and folders outside the home folder, even with a marker", () => {
    for (const d of ["Documents", "Desktop", "Downloads", "Library"]) {
      marker(join(userHome, d));
      expect(dataFolderProblem(join(userHome, d), userHome), d).toContain(d);
    }
    const outside = join(root, "elsewhere");
    marker(outside);
    expect(dataFolderProblem(outside, userHome)).toContain("not inside");
  });

  it("follows symlinks (a link inside HOME to a folder outside is refused)", () => {
    const outside = join(root, "elsewhere");
    marker(outside);
    symlinkSync(outside, join(userHome, "link"));
    expect(dataFolderProblem(join(userHome, "link"), userHome)).toContain("not inside");
  });

  it("needs a Psyche marker file", () => {
    mkdirSync(join(userHome, "photos"));
    expect(dataFolderProblem(join(userHome, "photos"), userHome)).toContain("no Psyche marker");
    mkdirSync(join(userHome, "other"));
    writeFileSync(join(userHome, "other", "config.json"), "{}");
    expect(dataFolderProblem(join(userHome, "other"), userHome)).toBeNull();
  });

  it("an empty PSYCHE_HOME counts as unset", () => {
    const plan = planUninstall({ ...deps, psycheHome: "" }, { deleteData: true });
    expect(plan.dataFolder).toBe(join(userHome, ".psyche"));
  });

  it("the agent's PSYCHE_HOME wins, with a warning when the environment differs", () => {
    const other = join(userHome, "other-env");
    marker(other);
    const plan = planUninstall(
      { ...deps, psycheHome: other, agentPsycheHome: join(userHome, ".psyche") },
      { deleteData: true },
    );
    expect(plan.dataFolder).toBe(join(userHome, ".psyche"));
    expect(plan.warnings.join(" ")).toContain("differs");
  });

  it("reads PSYCHE_HOME out of a LaunchAgent plist", () => {
    const plist = "<dict><key>PSYCHE_HOME</key>\n<string>/Users/a &amp; b/.psyche</string></dict>";
    expect(psycheHomeFromPlist(plist)).toBe("/Users/a & b/.psyche");
    expect(psycheHomeFromPlist("<plist/>")).toBeUndefined();
  });

  it("deleting data with a refused folder throws before anything is stopped", async () => {
    await expect(
      runUninstall(
        { ...deps, psycheHome: userHome },
        { deleteData: true, confirm: DELETE_CONFIRM_WORD },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
    expect(authorized).toEqual([]);
  });

  it("asks the Gateway about the exact resolved folder", async () => {
    await runUninstall(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD, approvalId: "a1" });
    expect(authorized).toEqual([{ path: join(userHome, ".psyche"), id: "a1" }]);
  });
});

describe("pre-flight (M1)", () => {
  it("flags AppTranslocation, /Volumes and a read-only parent", () => {
    expect(trashProblem("/Volumes/Backup/Psyche.app")).toContain("another volume");
    const t = join(root, "AppTranslocation", "X", "d", "Psyche.app");
    mkdirSync(t, { recursive: true });
    expect(trashProblem(t)).toContain("temporary");
    chmodSync(lib("Caches"), 0o555);
    expect(trashProblem(lib("Caches", "com.psyche.desktop"))).toContain("read-only");
  });

  it("an unwritable target stops everything before anything is stopped", async () => {
    chmodSync(lib("Caches"), 0o555);
    await expect(runUninstall(deps, { deleteData: false })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("Nothing was changed"),
    });
    expect(calls).toEqual([]);
  });

  it("a renamed app gets a clear error with the manual step", async () => {
    mkdirSync(join(root, "Applications", "Psy.app"));
    await expect(
      runUninstall(
        { ...deps, appBundlePath: join(root, "Applications", "Psy.app") },
        { deleteData: false },
      ),
    ).rejects.toThrow(/not Psyche\.app.*Finder/);
    expect(calls).toEqual([]);
  });

  it("the native confirmation can cancel, before anything is stopped", async () => {
    confirmAnswer = false;
    await expect(runUninstall(deps, { deleteData: false })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(calls).toEqual([]);
  });

  it("the typed word and presence come first", async () => {
    await expect(runUninstall(deps, { deleteData: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
    authorizeError = Object.assign(new Error("approval"), { code: "approval_required" });
    await expect(
      runUninstall(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD }),
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(calls).toEqual([]);
  });
});

describe("the happy path", () => {
  it("keep my data: stops, trashes the app last, never the data, then quits", async () => {
    const res = await runUninstall(deps, { deleteData: false });
    expect(res.failed).toEqual([]);
    expect(authorized).toEqual([]);
    expect(calls).toContain("/bin/launchctl bootout gui/501/com.psyche.gateway");
    expect(calls).toContain(`/usr/bin/pkill -f ${deps.helperAppPath}`);
    expect(trashes()).not.toContain(join(userHome, ".psyche"));
    expect(trashes().at(-1)).toBe(deps.appBundlePath);
    expect(calls.at(-1)).toBe("quit");
    expect(calls.indexOf("/bin/launchctl bootout gui/501/com.psyche.gateway")).toBeLessThan(
      calls.indexOf(`trash ${trashes()[0]}`),
    );
  });

  it("forgets both preference domains", async () => {
    await runUninstall(deps, { deleteData: false });
    expect(calls).toContain("/usr/bin/defaults delete com.psyche.desktop");
    expect(calls).toContain("/usr/bin/defaults delete com.psyche.helper");
  });

  it("Saved State is trashed only after the windows are closed", async () => {
    await runUninstall(deps, { deleteData: false });
    const state = `trash ${lib("Saved Application State", "com.psyche.desktop.savedState")}`;
    expect(calls.indexOf(state)).toBeGreaterThan(calls.indexOf("close-windows"));
    expect(calls.indexOf(`trash ${lib("Caches", "com.psyche.desktop")}`)).toBeLessThan(
      calls.indexOf("close-windows"),
    );
  });

  it("delete my data waits for the agent to be gone, then trashes ~/.psyche (never removes it)", async () => {
    loadedPolls = 3;
    await runUninstall(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD });
    const data = calls.indexOf(`trash ${join(userHome, ".psyche")}`);
    expect(data).toBeGreaterThan(-1);
    // bootout, then polls (3 loaded + 1 gone), all before the data moved.
    const polls = calls.map((c, i) => (c === "loaded?" ? i : -1)).filter((i) => i >= 0);
    expect(polls).toHaveLength(4);
    expect(Math.max(...polls)).toBeLessThan(data);
    expect(existsSync(join(userHome, ".psyche"))).toBe(true); // the fake trash moves nothing
  });

  it("removes the exact Keychain services only with the data and when asked", async () => {
    await runUninstall(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD });
    expect(calls.some((c) => c.startsWith("/usr/bin/security"))).toBe(false);
    calls.length = 0;
    securityLeft = 1;
    await runUninstall(deps, {
      deleteData: true,
      removeKeychain: true,
      confirm: DELETE_CONFIRM_WORD,
    });
    const sec = calls.filter((c) => c.startsWith("/usr/bin/security"));
    for (const svc of KEYCHAIN_SERVICES) {
      expect(sec.some((c) => c === `/usr/bin/security delete-generic-password -s ${svc}`)).toBe(
        true,
      );
    }
    calls.length = 0;
    await runUninstall(deps, { deleteData: false, removeKeychain: true });
    expect(calls.some((c) => c.startsWith("/usr/bin/security"))).toBe(false);
  });
});

describe("a pending update (M6)", () => {
  it("stops the updater and trashes the staged update and the ShipIt cache before quitting", async () => {
    const staged = join(root, "tmp", "psyche-update");
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(staged, "Psyche-2.0.0-arm64.zip"), "zip");
    stagedUpdate = [staged];
    mkdirSync(lib("Caches", "com.psyche.desktop.ShipIt"), { recursive: true });
    await runUninstall(deps, { deleteData: false });
    expect(calls.indexOf("stop-updater")).toBeLessThan(calls.indexOf("login false"));
    expect(trashes()).toContain(staged);
    expect(trashes()).toContain(lib("Caches", "com.psyche.desktop.ShipIt"));
    expect(calls.indexOf(`trash ${staged}`)).toBeLessThan(calls.indexOf("quit"));
  });
});

describe("another copy's agent (M2)", () => {
  it("leaves it alone: no bootout, its plist stays, and the plan says so", async () => {
    const other = { ...deps, agentOwner: () => "other" as const };
    const plan = planUninstall(other, { deleteData: false });
    expect(plan.agent).toBe("other");
    expect(plan.warnings.join(" ")).toContain("left alone");
    expect(plan.trash.some((i) => i.kind === "agent")).toBe(false);
    await runUninstall(other, { deleteData: false });
    expect(calls.some((c) => c.includes("bootout"))).toBe(false);
    expect(trashes()).not.toContain(lib("LaunchAgents", "com.psyche.gateway.plist"));
    expect(calls.at(-1)).toBe("quit");
  });

  it("trashes the plist when the agent is ours", () => {
    const plan = planUninstall(deps, { deleteData: false });
    expect(plan.trash.some((i) => i.kind === "agent")).toBe(true);
  });
});

describe("partial failure (M1)", () => {
  it("does not quit, reports the failed paths and starts the Gateway again", async () => {
    const bad = lib("Application Support", "Psyche");
    deps.trashItem = async (p) => {
      if (p === bad) throw new Error("denied");
      calls.push(`trash ${p}`);
    };
    const res = await runUninstall(deps, { deleteData: false });
    expect(res.failed.map((f) => f.path)).toEqual([bad]);
    expect(res.restarted).toBe(true);
    expect(calls).toContain("restart");
    expect(calls).not.toContain("quit");
    // The app itself is still there to retry from.
    expect(trashes()).not.toContain(deps.appBundlePath);
  });

  it("when bootout does not stop the agent, nothing is moved and the agent keeps running", async () => {
    loadedPolls = 1000;
    await expect(runUninstall(deps, { deleteData: true, confirm: "DELETE" })).rejects.toMatchObject(
      { code: "unavailable", message: expect.stringContaining("would not stop") },
    );
    expect(trashes()).toEqual([]);
    expect(calls).not.toContain("quit");
    expect(calls).toContain("restart");
  });

  it("does not restart the agent once the data folder is already in the Trash", async () => {
    const bad = lib("Caches", "com.psyche.desktop");
    deps.trashItem = async (p) => {
      if (p === bad) throw new Error("denied");
      calls.push(`trash ${p}`);
    };
    const res = await runUninstall(deps, { deleteData: true, confirm: "DELETE" });
    expect(res.restarted).toBe(false);
    expect(calls).not.toContain("restart");
  });
});

describe("the channels", () => {
  it("are refused in a remote window", () => {
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.appUninstallPlan)).toBe(true);
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.appUninstall)).toBe(true);
  });

  it("validate their payload", () => {
    expect(checkUninstall("c", { deleteData: false })).toEqual({ deleteData: false });
    expect(
      checkUninstall("c", {
        deleteData: true,
        removeKeychain: true,
        confirm: "DELETE",
        approvalId: "a",
      }),
    ).toEqual({ deleteData: true, removeKeychain: true, confirm: "DELETE", approvalId: "a" });
    for (const bad of [
      null,
      {},
      { deleteData: "yes" },
      { deleteData: true, confirm: 5 },
      { deleteData: true, removeKeychain: "y" },
    ]) {
      expect(() => checkUninstall("c", bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("UninstallError carries a protocol code", () => {
    expect(new UninstallError("cancelled", "x").code).toBe("cancelled");
  });
});
