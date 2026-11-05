import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import {
  currentUserSid,
  gatewayTaskName,
  LEGACY_GATEWAY_TASK,
  taskBelongsTo,
} from "@psyche/hostfs";
import { runElevated } from "./sandbox-pc/elevate.ts";
import { vmServiceExe } from "./squirrel-events.ts";
import { execRunner, type Runner } from "./supervisor-base.ts";
import {
  decodeTaskXml,
  gatewayTaskFile,
  schtasks,
  taskPsycheHome,
  taskRunsFrom,
  taskUri,
  windowsUserId,
} from "./supervisor-windows.ts";
import {
  parseCmdkeyTargets,
  STOP_HELPER_SCRIPT,
  spawnFinisher,
  type WindowsGatewayTask,
  type WindowsUninstallDeps,
} from "./uninstall-windows.ts";

/**
 * The real effects behind `WindowsUninstallDeps` (uninstall-windows.ts): Task Scheduler through
 * schtasks.exe, the Credential Manager through cmdkey.exe, the elevated service removal, pid files
 * and the finisher. Main supplies only what needs Electron or the Gateway connection. Nothing here
 * runs unless the owner confirmed the uninstall sheet.
 */

export interface WindowsHostCallbacks {
  /** Electron `shell.trashItem`. */
  trashItem: (path: string) => Promise<void>;
  setOpenAtLogin: (value: boolean) => void;
  restartAgent: () => Promise<void>;
  clearStagedUpdate: () => Promise<string[]>;
  authorizeDelete: WindowsUninstallDeps["authorizeDelete"];
  confirm: WindowsUninstallDeps["confirm"];
  showManualSteps: WindowsUninstallDeps["showManualSteps"];
  closeWindows: () => void;
  quit: () => void;
  log?: (message: string) => void;
}

export interface WindowsHostOptions {
  execPath: string;
  userDataDir: string;
  /** `$PSYCHE_HOME` as this app resolved it. */
  psycheHome: string | undefined;
  /** `<install root>\Update.exe` when Squirrel installed this copy. */
  updateExe: string | undefined;
  appData: string;
  env?: NodeJS.ProcessEnv;
}

const system32 = (env: NodeJS.ProcessEnv, exe: string): string =>
  join(env.SystemRoot ?? "C:\\Windows", "System32", exe);

function pidFrom(file: string): number | undefined {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Builds the dependencies for one plan or run (the task definitions are read fresh each time). */
export async function windowsUninstallDeps(
  o: WindowsHostOptions,
  cb: WindowsHostCallbacks,
): Promise<WindowsUninstallDeps> {
  const env = o.env ?? process.env;
  const profile = homedir();
  const localAppData = env.LOCALAPPDATA ?? join(profile, "AppData", "Local");
  const installRoot = o.updateExe === undefined ? null : win32.dirname(o.updateExe);
  const run: Runner = (file, args) =>
    execRunner(file.includes("\\") || file.includes("/") ? file : system32(env, file), args);
  const sid = currentUserSid();
  const userId = windowsUserId(env);
  const home = o.psycheHome === "" ? undefined : o.psycheHome;
  const stored = ((): string | undefined => {
    const file = gatewayTaskFile(home ?? win32.join(profile, ".psyche"));
    try {
      return existsSync(file) ? decodeTaskXml(readFileSync(file)) : undefined;
    } catch {
      return undefined;
    }
  })();
  /** The definition `task` runs: the exact stored one when it is that task's, else what schtasks prints. */
  const definitionOf = (task: string, printed: string): string =>
    stored !== undefined && taskUri(stored)?.toLowerCase() === task.toLowerCase()
      ? stored
      : printed;

  const tasks = async (): Promise<WindowsGatewayTask[]> => {
    if (sid === null || installRoot === null) return [];
    const out: WindowsGatewayTask[] = [];
    for (const name of [gatewayTaskName(sid), LEGACY_GATEWAY_TASK]) {
      const q = await run("schtasks.exe", [...schtasks.queryXml(name)]);
      if (q.code !== 0) continue;
      // The shared task of earlier versions is only ever this account's own.
      if (
        name === LEGACY_GATEWAY_TASK &&
        !taskBelongsTo(q.stdout, { sid, ...(userId ? { userId } : {}) })
      ) {
        continue;
      }
      out.push({
        name,
        owner: taskRunsFrom(definitionOf(name, q.stdout), installRoot) ? "ours" : "other",
      });
    }
    return out;
  };
  const agentHome = async (): Promise<string | undefined> => {
    const own = (await tasks()).find((t) => t.owner === "ours");
    if (own === undefined) return undefined;
    const q = await run("schtasks.exe", [...schtasks.queryXml(own.name)]);
    return q.code === 0 ? taskPsycheHome(definitionOf(own.name, q.stdout)) : undefined;
  };

  return {
    userProfile: profile,
    appData: o.appData,
    localAppData,
    psycheHome: home,
    agentPsycheHome: await agentHome(),
    installRoot,
    updateExe: o.updateExe ?? null,
    userDataDir: o.userDataDir,
    sid,
    exists: existsSync,
    realpath: (p) => realpathSync.native(p),
    canModify: (dir) => {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    run,
    trashItem: cb.trashItem,
    setOpenAtLogin: cb.setOpenAtLogin,
    gatewayTasks: tasks,
    gatewayPids: (h) =>
      ["gateway-service.pid", "gateway.pid"]
        .map((f) => pidFrom(win32.join(h, "run", f)))
        .filter((p): p is number => p !== undefined),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // EPERM: it exists but is not ours to signal.
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    stopHelper: () =>
      new Promise<void>((resolve) => {
        if (installRoot === null) return resolve();
        execFile(
          join(
            env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          ["-NoProfile", "-NonInteractive", "-Command", STOP_HELPER_SCRIPT],
          { env: { ...env, PSYCHE_INSTALL_ROOT: installRoot }, timeout: 15_000, windowsHide: true },
          () => resolve(),
        );
      }),
    credentialTargets: async () => parseCmdkeyTargets((await run("cmdkey.exe", ["/list"])).stdout),
    vmServiceExe: existsSync(vmServiceExe(o.execPath)) ? vmServiceExe(o.execPath) : null,
    elevatedServiceUninstall: async (ownerSid) => {
      const exe = vmServiceExe(o.execPath);
      if (!existsSync(exe)) return { ok: false };
      // A copy in %TEMP% does the work, so the install folder is free for Squirrel to delete.
      const copy = join(mkdtempSync(join(tmpdir(), "psyche-vm-uninstall-")), "psyche-vm-svc.exe");
      copyFileSync(exe, copy);
      const r = await runElevated(copy, ["uninstall", "--owner-sid", ownerSid]);
      return r.ok ? { ok: true } : { ok: false, cancelled: r.cancelled };
    },
    writeNote: (text) => {
      const file = join(tmpdir(), "Psyche-remove-sandbox-pc.txt");
      writeFileSync(file, text);
      return file;
    },
    showManualSteps: cb.showManualSteps,
    startFinisher: (deferred, updateExe) => spawnFinisher(deferred, updateExe, { env }),
    restartAgent: cb.restartAgent,
    clearStagedUpdate: cb.clearStagedUpdate,
    authorizeDelete: cb.authorizeDelete,
    confirm: cb.confirm,
    closeWindows: cb.closeWindows,
    quit: cb.quit,
    ...(cb.log === undefined ? {} : { log: cb.log }),
  };
}
