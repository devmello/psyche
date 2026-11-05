import { beforeEach, describe, expect, it } from "vitest";
import { checkUninstall, IPC, REMOTE_REFUSED_CHANNELS } from "../src/lib/ipc.ts";
import { SANDBOX_PC_HANDLED_ENV } from "../src/main/squirrel-events.ts";
import { DELETE_CONFIRM_WORD } from "../src/main/uninstall.ts";
import {
  CREDENTIAL_PREFIX,
  confirmDetailWindows,
  dataFolderProblemWindows,
  FINISH_SCRIPT,
  parseCmdkeyTargets,
  planUninstallWindows,
  recycleProblem,
  runUninstallWindows,
  STOP_HELPER_SCRIPT,
  safeTarget,
  type WindowsGatewayTask,
  type WindowsUninstallDeps,
} from "../src/main/uninstall-windows.ts";

/**
 * Everything runs on fake paths and fakes (a set of existing paths, a recording runner and Recycle
 * Bin): the real registry, Task Scheduler, service, Credential Manager and files are never
 * touched, and the tests run the same on every OS.
 */

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const TASK = `\\Psyche\\Gateway-${SID}`;
const PROFILE = "C:\\Users\\me";
const APPDATA = `${PROFILE}\\AppData\\Roaming`;
const LOCAL = `${PROFILE}\\AppData\\Local`;
const ROOT = `${LOCAL}\\Psyche`;
const UPDATE = `${ROOT}\\Update.exe`;
const HOME = `${PROFILE}\\.psyche`;
const USER_DATA = `${APPDATA}\\Psyche`;

let exists: Set<string>;
let calls: string[];
let tasks: WindowsGatewayTask[];
let pids: number[];
let alive: Set<number>;
let serviceInstalled: boolean;
let serviceAfterElevation: boolean;
let elevation: { ok: boolean; cancelled?: boolean } | "throw";
let credentials: string[];
let cmdkeyFails: Set<string>;
let trashFails: Set<string>;
let taskDeleteFails: boolean;
let stopFails: boolean;
let confirmAnswer: boolean;
let authorizeError: Error | null;
let authorized: { path: string; id: string | undefined }[];
let staged: string[];
let readOnly: Set<string>;
let deps: WindowsUninstallDeps;
let finisher: { deferred: string[]; updateExe: string } | null;
let finisherThrows: boolean;

const lc = (p: string) => p.toLowerCase();

beforeEach(() => {
  exists = new Set(
    [
      HOME,
      `${HOME}\\state\\psyche.sqlite`,
      USER_DATA,
      `${APPDATA}\\com.psyche.helper`,
      `${LOCAL}\\com.psyche.helper`,
      `${LOCAL}\\Psyche Helper`,
      `${ROOT}\\vm-images`,
      ROOT,
      UPDATE,
    ].map(lc),
  );
  calls = [];
  tasks = [{ name: TASK, owner: "ours" }];
  pids = [4001, 4002];
  alive = new Set([4001, 4002]);
  serviceInstalled = false;
  serviceAfterElevation = false;
  elevation = { ok: true };
  credentials = ["Psyche/vault/main", "Psyche/item/github#2", "Psyche/item/github"];
  cmdkeyFails = new Set();
  trashFails = new Set();
  taskDeleteFails = false;
  stopFails = false;
  confirmAnswer = true;
  authorizeError = null;
  authorized = [];
  staged = [];
  readOnly = new Set();
  finisher = null;
  finisherThrows = false;
  deps = {
    userProfile: PROFILE,
    appData: APPDATA,
    localAppData: LOCAL,
    psycheHome: HOME,
    installRoot: ROOT,
    updateExe: UPDATE,
    userDataDir: USER_DATA,
    sid: SID,
    exists: (p) => exists.has(lc(p)),
    realpath: (p) => p,
    canModify: (d) => !readOnly.has(lc(d)),
    run: async (file, args) => {
      calls.push(`${file} ${args.join(" ")}`);
      if (file === "sc.exe") {
        const installed = calls.some((c) => c === "elevated")
          ? serviceAfterElevation
          : serviceInstalled;
        return { code: installed ? 0 : 1060, stdout: "", stderr: "" };
      }
      if (file === "schtasks.exe" && args[0] === "/Query") {
        const stillThere = tasks.some((t) => t.name === args[2]) && taskDeleteFails;
        const deleted = calls.some((c) => c === `schtasks.exe /Delete /TN ${args[2]} /F`);
        return { code: !deleted || stillThere ? 0 : 1, stdout: "", stderr: "" };
      }
      if (file === "cmdkey.exe") {
        const t = String(args[0]).slice("/delete:".length);
        return { code: cmdkeyFails.has(t) ? 1 : 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    trashItem: async (p) => {
      if (trashFails.has(p)) throw new Error("in use");
      calls.push(`trash ${p}`);
    },
    setOpenAtLogin: (v) => calls.push(`login ${v}`),
    gatewayTasks: async () => tasks,
    gatewayPids: () => pids,
    pidAlive: (pid) => alive.has(pid),
    stopHelper: async () => {
      calls.push("stop-helper");
    },
    credentialTargets: async () => credentials,
    vmServiceExe: `${ROOT}\\app-1.0.0\\resources\\win-helper\\psyche-vm-svc.exe`,
    elevatedServiceUninstall: async (sid) => {
      calls.push("elevated");
      calls.push(`elevated-sid ${sid}`);
      if (elevation === "throw") throw new Error("copy failed");
      return elevation;
    },
    writeNote: (text) => {
      calls.push("note");
      expect(text).toContain(`sc.exe delete PsycheVM-${SID}`);
      return "C:\\Temp\\Psyche-remove-sandbox-pc.txt";
    },
    showManualSteps: async () => {
      calls.push("show-manual");
    },
    startFinisher: (deferred, updateExe) => {
      if (finisherThrows) throw new Error("no powershell");
      finisher = { deferred, updateExe };
      calls.push("finisher");
    },
    restartAgent: async () => {
      calls.push("restart");
    },
    clearStagedUpdate: async () => {
      calls.push("stop-updater");
      return staged;
    },
    authorizeDelete: async (path, id) => {
      authorized.push({ path, id });
      if (authorizeError) throw authorizeError;
    },
    confirm: async () => confirmAnswer,
    closeWindows: () => calls.push("close-windows"),
    quit: () => calls.push("quit"),
    sleep: async () => {
      // Each wait lets a stubborn Gateway finally exit unless the test says it never does.
      if (!stopFails) alive.clear();
    },
  };
  // `schtasks /End` and `taskkill` end the Gateway unless the test says it will not stop.
  const run = deps.run;
  deps.run = async (file, args) => {
    const r = await run(file, args);
    if (file === "taskkill.exe" && !stopFails) alive.clear();
    return r;
  };
});

const trashes = () => calls.filter((c) => c.startsWith("trash ")).map((c) => c.slice(6));
const at = (c: string) => calls.indexOf(c);

describe("the data-folder rules", () => {
  const d = () => ({ realpath: (p: string) => p, exists: (p: string) => exists.has(lc(p)) });

  it("accepts a marked folder strictly inside the user folder, in any case and with a slash", () => {
    expect(dataFolderProblemWindows(HOME, PROFILE, d())).toBeNull();
    expect(dataFolderProblemWindows(`${HOME}\\`, PROFILE, d())).toBeNull();
    expect(dataFolderProblemWindows(HOME.toUpperCase(), PROFILE, d())).toBeNull();
  });

  it("refuses an empty value, relative and rooted-without-a-drive paths, drives and shares", () => {
    for (const bad of [
      undefined,
      "",
      ".psyche",
      "\\Users\\me\\.psyche",
      "C:",
      "C:\\",
      "D:\\",
      "\\\\server\\share\\.psyche",
      "\\\\?\\UNC\\server\\share",
    ]) {
      expect(dataFolderProblemWindows(bad, PROFILE, d()), String(bad)).not.toBeNull();
    }
  });

  it("refuses the user folder, its ancestors and folders outside it, even with a marker", () => {
    for (const bad of [PROFILE, `${PROFILE}\\`, `${PROFILE}\\.`, "C:\\Users", "C:\\Windows"]) {
      exists.add(lc(`${bad}\\config.json`));
      expect(dataFolderProblemWindows(bad, PROFILE, d()), bad).not.toBeNull();
    }
    exists.add(lc("D:\\data\\config.json"));
    expect(dataFolderProblemWindows("D:\\data", PROFILE, d())).toContain("not inside");
  });

  it("refuses the personal folders even with a marker, in any case", () => {
    for (const f of ["Desktop", "Documents", "Downloads", "OneDrive", "AppData", "Pictures"]) {
      exists.add(lc(`${PROFILE}\\${f}\\config.json`));
      expect(dataFolderProblemWindows(`${PROFILE}\\${f}`, PROFILE, d()), f).toContain(f);
      expect(dataFolderProblemWindows(`${PROFILE}\\${f.toUpperCase()}`, PROFILE, d())).toContain(f);
    }
  });

  it("needs a Psyche marker file", () => {
    expect(dataFolderProblemWindows(`${PROFILE}\\photos`, PROFILE, d())).toContain(
      "no Psyche marker",
    );
    exists.add(lc(`${PROFILE}\\other\\config.json`));
    expect(dataFolderProblemWindows(`${PROFILE}\\other`, PROFILE, d())).toBeNull();
  });

  it("follows links (a resolved path outside the user folder is refused)", () => {
    exists.add(lc("D:\\elsewhere\\config.json"));
    const link = {
      realpath: (p: string) => (p.endsWith("\\link") ? "D:\\elsewhere" : p),
      exists: d().exists,
    };
    expect(dataFolderProblemWindows(`${PROFILE}\\link`, PROFILE, link)).toContain("not inside");
  });
});

describe("the plan", () => {
  it("keep my data (the default) lists the Recycle Bin items, never the data folder", async () => {
    const plan = await planUninstallWindows(deps, { deleteData: false });
    const paths = plan.trash.map((i) => i.path);
    expect(paths).toEqual([
      USER_DATA,
      `${APPDATA}\\com.psyche.helper`,
      `${LOCAL}\\com.psyche.helper`,
      `${LOCAL}\\Psyche Helper`,
      `${ROOT}\\vm-images`,
      ROOT,
    ]);
    expect(plan.trash.at(-1)?.kind).toBe("app");
    expect(plan.dataFolder).toBeUndefined();
    expect(plan.agent).toBe("ours");
    expect(plan.tasks).toEqual([TASK]);
    expect(plan.keychain).toEqual([]);
    expect(plan.blockers).toEqual([]);
    expect(plan.sandboxPc).toBeUndefined();
  });

  it("lists only what exists", async () => {
    exists.delete(lc(`${LOCAL}\\Psyche Helper`));
    exists.delete(lc(`${ROOT}\\vm-images`));
    const plan = await planUninstallWindows(deps, { deleteData: false });
    expect(plan.trash.map((i) => i.path)).not.toContain(`${LOCAL}\\Psyche Helper`);
    expect(plan.trash.map((i) => i.path)).not.toContain(`${ROOT}\\vm-images`);
  });

  it("delete my data adds the folder; the credential list only when asked, only Psyche/", async () => {
    credentials = ["Psyche/vault/main", "Other/thing", 'Psyche/a"b', "Psyche/"];
    const plan = await planUninstallWindows(deps, { deleteData: true });
    expect(plan.trash.find((i) => i.kind === "data")?.path).toBe(HOME);
    expect(plan.dataFolder).toBe(HOME);
    expect(plan.keychain).toEqual([]);
    const withKeys = await planUninstallWindows(deps, { deleteData: true, removeKeychain: true });
    expect(withKeys.keychain).toEqual(["Psyche/vault/main"]);
    // Never without the data, whatever was asked.
    const without = await planUninstallWindows(deps, { deleteData: false, removeKeychain: true });
    expect(without.keychain).toEqual([]);
  });

  it("an empty PSYCHE_HOME counts as unset", async () => {
    const plan = await planUninstallWindows({ ...deps, psycheHome: "" }, { deleteData: true });
    expect(plan.dataFolder).toBe(HOME);
  });

  it("the task's --home wins, with a warning when the environment differs", async () => {
    const other = `${PROFILE}\\other-env`;
    exists.add(lc(`${other}\\config.json`));
    exists.add(lc(other));
    const plan = await planUninstallWindows(
      { ...deps, psycheHome: other, agentPsycheHome: HOME },
      { deleteData: true },
    );
    expect(plan.dataFolder).toBe(HOME);
    expect(plan.warnings.join(" ")).toContain("differs");
  });

  it("another copy's task is left alone, with a warning", async () => {
    tasks = [{ name: TASK, owner: "other" }];
    const plan = await planUninstallWindows(deps, { deleteData: false });
    expect(plan.agent).toBe("other");
    expect(plan.tasks).toEqual([]);
    expect(plan.warnings.join(" ")).toContain("another copy");
    expect(plan.stops.some((s) => s.kind === "agent")).toBe(false);
  });

  it("no task at all is fine", async () => {
    tasks = [];
    const plan = await planUninstallWindows(deps, { deleteData: false });
    expect(plan.agent).toBe("none");
    expect(plan.tasks).toEqual([]);
  });

  it("our task and the shared one of an earlier version are both planned; a foreign one is not", async () => {
    tasks = [
      { name: TASK, owner: "ours" },
      { name: "\\Psyche\\Gateway", owner: "ours" },
    ];
    expect((await planUninstallWindows(deps, { deleteData: false })).tasks).toEqual([
      TASK,
      "\\Psyche\\Gateway",
    ]);
    tasks = [
      { name: TASK, owner: "ours" },
      { name: "\\Psyche\\Gateway", owner: "other" },
    ];
    const plan = await planUninstallWindows(deps, { deleteData: false });
    expect(plan.tasks).toEqual([TASK]);
    expect(plan.warnings.join(" ")).toContain("\\Psyche\\Gateway");
  });

  it("plans the sandbox PC service only when it is installed", async () => {
    expect((await planUninstallWindows(deps, { deleteData: false })).sandboxPc).toBeUndefined();
    serviceInstalled = true;
    const plan = await planUninstallWindows(deps, { deleteData: false });
    expect(plan.sandboxPc).toEqual({ service: `PsycheVM-${SID}`, sid: SID });
    expect(plan.stops.some((s) => s.kind === "service")).toBe(true);
  });

  it("a copy Squirrel did not install, or one outside %LOCALAPPDATA%\\Psyche, is refused", async () => {
    await expect(
      planUninstallWindows({ ...deps, installRoot: null, updateExe: null }, { deleteData: false }),
    ).rejects.toMatchObject({ code: "forbidden" });
    for (const root of [
      `${PROFILE}\\Psyche`,
      `${LOCAL}\\Other`,
      LOCAL,
      "C:\\Program Files\\Psyche",
    ]) {
      await expect(
        planUninstallWindows({ ...deps, installRoot: root }, { deleteData: false }),
      ).rejects.toMatchObject({ code: "forbidden" });
    }
  });

  it("a refused data folder is an error, not a silent skip", async () => {
    await expect(
      planUninstallWindows({ ...deps, psycheHome: PROFILE }, { deleteData: true }),
    ).rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining("Recycle Bin") });
  });

  it("an unwritable folder, a network share or a missing SID shows up before anything runs", async () => {
    readOnly.add(lc(LOCAL));
    const plan = await planUninstallWindows(deps, { deleteData: false });
    expect(plan.blockers.map((b) => b.path)).toContain(`${LOCAL}\\com.psyche.helper`);
    expect(
      recycleProblem("\\\\server\\share\\x", { realpath: (p) => p, canModify: () => true }),
    ).toContain("network");
    const noSid = await planUninstallWindows({ ...deps, sid: null }, { deleteData: false });
    expect(noSid.warnings.join(" ")).toContain("whoami");
    expect(noSid.sandboxPc).toBeUndefined();
  });

  it("changes nothing while planning", async () => {
    serviceInstalled = true;
    await planUninstallWindows(deps, { deleteData: true, removeKeychain: true });
    expect(calls.every((c) => c.startsWith("sc.exe query"))).toBe(true);
  });
});

describe("refusals before anything is stopped", () => {
  it("an unwritable target stops everything with 'Nothing was changed'", async () => {
    readOnly.add(lc(APPDATA));
    await expect(runUninstallWindows(deps, { deleteData: false })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("Nothing was changed"),
    });
    expect(calls.filter((c) => !c.startsWith("sc.exe query"))).toEqual([]);
  });

  it("the typed word comes first, then presence, then the native confirmation", async () => {
    await expect(runUninstallWindows(deps, { deleteData: true })).rejects.toMatchObject({
      code: "invalid_params",
    });
    authorizeError = Object.assign(new Error("approval"), { code: "approval_required" });
    await expect(
      runUninstallWindows(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD }),
    ).rejects.toMatchObject({ code: "approval_required" });
    authorizeError = null;
    confirmAnswer = false;
    await expect(runUninstallWindows(deps, { deleteData: false })).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(calls.filter((c) => !c.startsWith("sc.exe query"))).toEqual([]);
  });

  it("deleting data with a refused folder throws before authorization", async () => {
    await expect(
      runUninstallWindows(
        { ...deps, psycheHome: PROFILE },
        { deleteData: true, confirm: DELETE_CONFIRM_WORD },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(authorized).toEqual([]);
  });

  it("asks the Gateway about the exact resolved folder, with the approved card", async () => {
    await runUninstallWindows(deps, {
      deleteData: true,
      confirm: DELETE_CONFIRM_WORD,
      approvalId: "a1",
    });
    expect(authorized).toEqual([{ path: HOME, id: "a1" }]);
  });
});

describe("the happy path", () => {
  it("keep my data: stops, removes keys, ends the task, recycles, finishes, quits", async () => {
    const res = await runUninstallWindows(deps, { deleteData: false });
    expect(res.failed).toEqual([]);
    expect(authorized).toEqual([]);
    expect(trashes()).not.toContain(HOME);
    expect(trashes()).toEqual([
      `${APPDATA}\\com.psyche.helper`,
      `${LOCAL}\\com.psyche.helper`,
      `${LOCAL}\\Psyche Helper`,
      `${ROOT}\\vm-images`,
    ]);
    // Chromium has its user data open: that folder waits for the finisher, and the app is Squirrel's.
    expect(res.deferred).toEqual([USER_DATA]);
    expect(finisher).toEqual({ deferred: [USER_DATA], updateExe: UPDATE });
    expect(trashes()).not.toContain(ROOT);
    expect(calls.at(-1)).toBe("quit");
    expect(at("stop-updater")).toBeLessThan(at(`schtasks.exe /End /TN ${TASK}`));
    expect(at("login false")).toBeGreaterThan(-1);
    expect(at("stop-helper")).toBeGreaterThan(-1);
    expect(at(`schtasks.exe /End /TN ${TASK}`)).toBeLessThan(
      at(`schtasks.exe /Delete /TN ${TASK} /F`),
    );
    expect(at(`schtasks.exe /Delete /TN ${TASK} /F`)).toBeLessThan(at(`trash ${trashes()[0]}`));
    expect(at("close-windows")).toBeLessThan(at("finisher"));
    expect(at("finisher")).toBeLessThan(at("quit"));
    expect(calls.filter((c) => c.startsWith("cmdkey.exe"))).toEqual([]);
  });

  it("ends the Gateway's processes by pid and waits until they are gone", async () => {
    await runUninstallWindows(deps, { deleteData: false });
    expect(calls).toContain("taskkill.exe /PID 4001 /T /F");
    expect(calls).toContain("taskkill.exe /PID 4002 /T /F");
    expect(at("taskkill.exe /PID 4001 /T /F")).toBeLessThan(
      at(`schtasks.exe /Delete /TN ${TASK} /F`),
    );
  });

  it("removes the handlers, the login item's keys and the toast keys with reg.exe", async () => {
    await runUninstallWindows(deps, { deleteData: false });
    const reg = calls.filter((c) => c.startsWith("reg.exe delete"));
    const text = reg.join("\n");
    expect(text).toContain("Software\\Classes\\psyche /f");
    expect(text).toContain("Software\\Classes\\psyche-pair /f");
    expect(text).toContain("CurrentVersion\\Run /v Psyche /f");
    expect(text).toContain("StartupApproved\\Run /v Psyche /f");
    expect(text).toContain("Software\\Classes\\AppUserModelId\\");
    expect(text).toContain("Notifications\\Settings\\");
    expect(text).toContain("Software\\Classes\\CLSID\\");
    // Always HKCU: never a machine-wide key.
    expect(reg.every((c) => c.includes("HKCU\\"))).toBe(true);
  });

  it("delete my data waits for the Gateway to be gone, then recycles the data folder (last of the files)", async () => {
    await runUninstallWindows(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD });
    expect(trashes().at(-1)).toBe(HOME);
    expect(at(`trash ${HOME}`)).toBeGreaterThan(at(`schtasks.exe /Delete /TN ${TASK} /F`));
  });

  it("the Credential Manager items go only with the data, only when asked, exactly the planned ones", async () => {
    await runUninstallWindows(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD });
    expect(calls.filter((c) => c.startsWith("cmdkey.exe"))).toEqual([]);
    calls.length = 0;
    await runUninstallWindows(deps, {
      deleteData: true,
      removeKeychain: true,
      confirm: DELETE_CONFIRM_WORD,
    });
    const deletes = calls.filter((c) => c.startsWith("cmdkey.exe"));
    expect(deletes).toEqual([
      "cmdkey.exe /delete:Psyche/vault/main",
      "cmdkey.exe /delete:Psyche/item/github#2",
      "cmdkey.exe /delete:Psyche/item/github",
    ]);
    expect(deletes.every((c) => c.startsWith(`cmdkey.exe /delete:${CREDENTIAL_PREFIX}`))).toBe(
      true,
    );
    expect(at(`trash ${HOME}`)).toBeLessThan(at(deletes[0] as string));
  });

  it("leaves another copy's task alone: no End, no Delete, no pid kill", async () => {
    tasks = [{ name: TASK, owner: "other" }];
    await runUninstallWindows(deps, { deleteData: false });
    expect(calls.some((c) => c.startsWith("schtasks.exe /End"))).toBe(false);
    expect(calls.some((c) => c.startsWith("schtasks.exe /Delete"))).toBe(false);
    expect(calls.some((c) => c.startsWith("taskkill.exe"))).toBe(false);
    expect(calls.at(-1)).toBe("quit");
  });

  it("a staged update goes to the Recycle Bin too", async () => {
    staged = ["C:\\Temp\\psyche-update"];
    await runUninstallWindows(deps, { deleteData: false });
    expect(trashes()).toContain("C:\\Temp\\psyche-update");
  });
});

describe("the sandbox PC service", () => {
  beforeEach(() => {
    serviceInstalled = true;
  });

  it("one elevated removal for this account's service, before anything is stopped", async () => {
    serviceAfterElevation = false;
    const res = await runUninstallWindows(deps, { deleteData: false });
    expect(calls.filter((c) => c === "elevated")).toHaveLength(1);
    expect(calls).toContain(`elevated-sid ${SID}`);
    expect(at("elevated")).toBeLessThan(at("stop-updater"));
    expect(res.manual).toEqual([]);
    expect(calls).not.toContain("note");
    expect(calls.at(-1)).toBe("quit");
  });

  it.each([
    ["the prompt is dismissed", { ok: false, cancelled: true } as const],
    ["the account cannot elevate", { ok: false } as const],
    ["the copy fails", "throw" as const],
  ])(
    "when %s, the manual steps are written and shown, and the uninstall goes on",
    async (_n, e) => {
      elevation = e;
      serviceAfterElevation = true;
      const res = await runUninstallWindows(deps, { deleteData: false });
      expect(res.manual).toHaveLength(1);
      expect(res.manual[0]).toContain(`sc.exe stop PsycheVM-${SID}`);
      expect(res.manual[0]).toContain("Psyche-remove-sandbox-pc.txt");
      expect(at("note")).toBeLessThan(at("show-manual"));
      expect(at("show-manual")).toBeLessThan(at("finisher"));
      expect(calls.at(-1)).toBe("quit");
    },
  );

  it("an elevated run that left the service installed still counts as not removed", async () => {
    elevation = { ok: true };
    serviceAfterElevation = true;
    const res = await runUninstallWindows(deps, { deleteData: false });
    expect(res.manual).toHaveLength(1);
  });

  it("no service, no prompt", async () => {
    serviceInstalled = false;
    await runUninstallWindows(deps, { deleteData: false });
    expect(calls).not.toContain("elevated");
  });
});

describe("failures", () => {
  it("a Gateway that will not stop leaves everything as it was and starts it again", async () => {
    stopFails = true;
    await expect(
      runUninstallWindows(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringMatching(/would not stop.*nothing was moved.*running again/is),
    });
    expect(trashes()).toEqual([]);
    expect(calls).toContain("restart");
    expect(calls).not.toContain("quit");
    expect(finisher).toBeNull();
  });

  it("a task that will not delete leaves everything as it was", async () => {
    taskDeleteFails = true;
    await expect(runUninstallWindows(deps, { deleteData: false })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("would not delete"),
    });
    expect(trashes()).toEqual([]);
    expect(calls).toContain("restart");
    expect(calls).not.toContain("quit");
  });

  it("a path that cannot be recycled is reported, the rest still goes, the app stays open and the Gateway comes back", async () => {
    trashFails.add(`${LOCAL}\\com.psyche.helper`);
    const res = await runUninstallWindows(deps, { deleteData: false });
    expect(res.failed.map((f) => f.path)).toEqual([`${LOCAL}\\com.psyche.helper`]);
    expect(trashes()).toContain(`${ROOT}\\vm-images`);
    expect(res.restarted).toBe(true);
    expect(calls).not.toContain("quit");
    expect(calls).not.toContain("close-windows");
    expect(finisher).toBeNull();
  });

  it("with the data already in the Recycle Bin, the Gateway is not started again", async () => {
    trashFails.add(`${LOCAL}\\com.psyche.helper`);
    const res = await runUninstallWindows(deps, { deleteData: true, confirm: DELETE_CONFIRM_WORD });
    expect(trashes()).toContain(HOME);
    expect(res.restarted).toBe(false);
    expect(calls).not.toContain("restart");
    expect(calls).not.toContain("quit");
  });

  it("a Credential Manager item that will not go is reported and keeps the app open", async () => {
    cmdkeyFails.add("Psyche/vault/main");
    const res = await runUninstallWindows(deps, {
      deleteData: true,
      removeKeychain: true,
      confirm: DELETE_CONFIRM_WORD,
    });
    expect(res.failed.map((f) => f.path)).toEqual(["Credential Manager item Psyche/vault/main"]);
    expect(calls).not.toContain("quit");
  });

  it("a finisher that cannot start keeps the app open and names the install folder", async () => {
    finisherThrows = true;
    const res = await runUninstallWindows(deps, { deleteData: false });
    expect(res.failed.map((f) => f.path)).toEqual([ROOT]);
    expect(calls).not.toContain("quit");
  });
});

describe("helpers", () => {
  it("reads only Psyche/ targets from cmdkey output, in any display language", () => {
    const out = [
      "",
      "Currently stored credentials:",
      "",
      "    Target: LegacyGeneric:target=Psyche/vault/main",
      "    Type: Generic",
      "    Ziel: LegacyGeneric:target=Psyche/item/github#2",
      "    Target: LegacyGeneric:target=Psyche/item/github#2   ",
      "    Target: LegacyGeneric:target=psyche/lowercase",
      "    Target: LegacyGeneric:target=com.psyche.vault",
      "    Target: Domain:target=MicrosoftAccount:user=a@b.c",
      "    Target: LegacyGeneric:target=Psyche/",
    ].join("\r\n");
    expect(parseCmdkeyTargets(out)).toEqual(["Psyche/item/github#2", "Psyche/vault/main"]);
  });

  it("safeTarget needs the prefix, something after it, one line and no quote", () => {
    expect(safeTarget("Psyche/vault/main")).toBe(true);
    for (const bad of ["Psyche/", "Other/x", 'Psyche/a"b', "Psyche/a\nb", "psyche/x", ""]) {
      expect(safeTarget(bad), bad).toBe(false);
    }
  });

  it("the finisher's and the helper-stop scripts are constants: paths travel in the environment", () => {
    for (const s of [FINISH_SCRIPT, STOP_HELPER_SCRIPT]) {
      expect(s).not.toContain("${");
      expect(s).not.toContain("C:\\Users");
    }
    expect(FINISH_SCRIPT).toContain("$env:PSYCHE_TRASH_PATHS");
    expect(FINISH_SCRIPT).toContain("SendToRecycleBin");
    expect(FINISH_SCRIPT).toContain("--uninstall");
    expect(STOP_HELPER_SCRIPT).toContain("$env:PSYCHE_INSTALL_ROOT");
    expect(SANDBOX_PC_HANDLED_ENV).toBe("PSYCHE_SANDBOX_PC_HANDLED");
  });

  it("the native confirmation says what happens", async () => {
    const plan = await planUninstallWindows(deps, { deleteData: true, removeKeychain: true });
    const text = confirmDetailWindows(plan);
    expect(text).toContain("Recycle Bin");
    expect(text).toContain(HOME);
    expect(text).toContain("3 Credential Manager item(s)");
    expect(confirmDetailWindows(await planUninstallWindows(deps, { deleteData: false }))).toContain(
      "data folder is kept",
    );
  });

  it("the IPC channels stay main-only and take the same request", () => {
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.appUninstallPlan)).toBe(true);
    expect(REMOTE_REFUSED_CHANNELS.has(IPC.appUninstall)).toBe(true);
    expect(checkUninstall(IPC.appUninstall, { deleteData: false })).toEqual({ deleteData: false });
  });
});
