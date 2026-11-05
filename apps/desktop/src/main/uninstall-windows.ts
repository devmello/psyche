import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { SANDBOX_PC_HANDLED_ENV, uninstallRegistryEntries } from "./squirrel-events.ts";
import type { Runner } from "./supervisor-base.ts";
import { schtasks } from "./supervisor-windows.ts";
import {
  DELETE_CONFIRM_WORD,
  type PlanOptions,
  UninstallError,
  type UninstallItem,
  type UninstallItemKind,
  type UninstallPlan,
  type UninstallRequest,
  type UninstallResult,
} from "./uninstall.ts";

/**
 * Uninstall Psyche on Windows (docs/design/updates-and-install-2026.md section 3.5, the Windows
 * counterpart of `uninstall.ts`): the same sheet, the same rules, the Recycle Bin instead of the
 * Trash, Windows Hello (the Gateway's presence gate) instead of Touch ID. `uninstall.ts` stays the
 * macOS implementation; main.ts picks one by platform. Every outside effect comes in through
 * `WindowsUninstallDeps`, so tests run it on fake paths and fakes (nothing here touches the real
 * registry, task, service or files).
 *
 * What it plans (nothing is changed while planning):
 *   - the per-user Gateway task `\Psyche\Gateway-<SID>` (and this account's shared `\Psyche\Gateway`
 *     of an earlier version) when it runs from THIS install folder; another copy's task is left
 *     alone and said so;
 *   - the helper, open at login, the psyche:// handlers and the toast keys;
 *   - the sandbox PC's service `PsycheVM-<SID>` when installed: removing it needs administrator
 *     rights, so one UAC prompt, and the exact commands to run by hand when that fails;
 *   - to the Recycle Bin: %APPDATA%\Psyche, the helper's and Gateway's per-user folders, the
 *     sandbox PC's guest image, a staged update, and with "Delete my data" the data folder
 *     (`%USERPROFILE%\.psyche`, or what the task runs with);
 *   - with "Delete my data" and the checkbox: Credential Manager entries whose target starts with
 *     `Psyche/` (exactly the ones the helper writes), listed one by one;
 *   - the app itself, which Squirrel's `Update.exe --uninstall` removes (it does not use the
 *     Recycle Bin; reinstalling is what brings it back).
 *
 * Order, as on the Mac: everything that can refuse does so before anything is stopped; then the
 * updater is stopped, the helper, login item and handlers go, the Gateway task is ended and
 * deleted (a Gateway that will not stop leaves everything as it was), the sandbox service is
 * removed, files go to the Recycle Bin, and only when every step worked the app hands over to a
 * detached finisher and quits. Chromium keeps %APPDATA%\Psyche open while the app runs, so that
 * folder (and only that) is moved by the finisher after the process has exited, followed by
 * `Update.exe --uninstall`, which runs the app's `--squirrel-uninstall` hook for what is left.
 */

/** The Windows personal folders a data folder may never be (compared case-insensitively). */
const PERSONAL_FOLDERS = [
  "AppData",
  "Contacts",
  "Desktop",
  "Documents",
  "Downloads",
  "Favorites",
  "Links",
  "Music",
  "OneDrive",
  "Pictures",
  "Saved Games",
  "Searches",
  "Videos",
  "3D Objects",
];

/** Files that show a folder is a Psyche data folder; one is required before it is moved. */
export const DATA_MARKERS_WINDOWS = [win32.join("state", "psyche.sqlite"), "config.json"];

/** The Credential Manager target prefix the helper writes (apps/win-helper/src/keychain). */
export const CREDENTIAL_PREFIX = "Psyche/";

/** Windows' "service does not exist". */
const SERVICE_NOT_INSTALLED = 1060;

export interface WindowsGatewayTask {
  /** `\Psyche\Gateway-<SID>` or the shared `\Psyche\Gateway`. */
  name: string;
  /** Whether its definition runs the runtime of THIS install folder. */
  owner: "ours" | "other";
}

export interface WindowsUninstallDeps {
  userProfile: string;
  appData: string;
  localAppData: string;
  /** `$PSYCHE_HOME` as this app resolved it (an empty value counts as unset). */
  psycheHome: string | undefined;
  /** `--home` of the installed Gateway task, which wins when present. */
  agentPsycheHome?: string | undefined;
  /** `%LOCALAPPDATA%\Psyche` (Squirrel), or null for a copy Squirrel did not install. */
  installRoot: string | null;
  /** `<installRoot>\Update.exe`. */
  updateExe: string | null;
  /** This process's Electron user data (`%APPDATA%\Psyche`); moved after the app has quit. */
  userDataDir: string;
  /** The account's SID, which names the task and the service; null when Windows would not say. */
  sid: string | null;
  exists: (path: string) => boolean;
  /** Resolves links and junctions (`fs.realpathSync.native`); a missing path may throw. */
  realpath: (path: string) => string;
  /** Whether this account may change the folder (so a child can be moved out of it). */
  canModify: (dir: string) => boolean;
  run: Runner;
  /** Electron `shell.trashItem`, which sends to the Recycle Bin. */
  trashItem: (path: string) => Promise<void>;
  setOpenAtLogin: (value: boolean) => void;
  /** The Gateway tasks that exist for this account, each with who runs it. */
  gatewayTasks: () => Promise<WindowsGatewayTask[]>;
  /** The `run\gateway-service.pid` / `gateway.pid` in `home`. */
  gatewayPids: (home: string) => number[];
  pidAlive: (pid: number) => boolean;
  /** Ends the helper that belongs to this install folder. */
  stopHelper: () => Promise<void>;
  /** The Credential Manager targets that start with `Psyche/`. */
  credentialTargets: () => Promise<string[]>;
  /** `psyche-vm-svc.exe` of this build, or null when it is not bundled. */
  vmServiceExe: string | null;
  /** One UAC prompt: runs an elevated copy of `psyche-vm-svc.exe uninstall --owner-sid <sid>`. */
  elevatedServiceUninstall: (sid: string) => Promise<{ ok: boolean; cancelled?: boolean }>;
  /** Leaves the manual steps in a text file in %TEMP%; returns its path. */
  writeNote: (text: string) => string;
  /** Shows the manual steps before the app quits. */
  showManualSteps: (text: string) => Promise<void>;
  /** Starts the detached finisher: moves `deferred` to the Recycle Bin, then `Update.exe --uninstall`. */
  startFinisher: (deferred: string[], updateExe: string) => void;
  /** Starts the Gateway again (`supervisor.ensureRunning()`). */
  restartAgent: () => Promise<void>;
  /** Stops the updater and clears a staged update so nothing reinstalls the app. */
  clearStagedUpdate: () => Promise<string[]>;
  /** Asks the Gateway for fresh presence for exactly this folder; throws `approval_required`. */
  authorizeDelete: (dataFolder: string, approvalId: string | undefined) => Promise<void>;
  /** A native confirmation main shows before anything is stopped. */
  confirm: (plan: WindowsUninstallPlan) => Promise<boolean>;
  closeWindows: () => void;
  quit: () => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface WindowsUninstallPlan extends UninstallPlan {
  /** The Gateway tasks that will be ended and deleted (only ours). */
  tasks: string[];
  /** The data folder the Gateway uses, whether or not it is deleted (for its pid files). */
  home: string;
  /** The sandbox PC service to remove with one UAC prompt, when installed. */
  sandboxPc?: { service: string; sid: string };
}

export interface WindowsUninstallResult extends UninstallResult {
  /** Items the finisher moves after the app has quit. */
  deferred: string[];
  /** Manual steps the owner was shown (the sandbox PC service could not be removed). */
  manual: string[];
}

/** The steps to finish by hand when something could not be moved to the Recycle Bin. */
export const UNINSTALL_MANUAL_STEPS_WINDOWS =
  "Finish by hand: move the listed items to the Recycle Bin in File Explorer, then remove Psyche in Settings › Apps › Installed apps.";

function strip(p: string): string {
  const n = win32.normalize(p);
  return n.length > 3 ? n.replace(/\\+$/, "") : n;
}

const lower = (p: string): string => strip(p).toLowerCase();

function isInside(parent: string, child: string): boolean {
  const c = lower(child);
  const p = lower(parent);
  return c === p || c.startsWith(`${p.replace(/\\+$/, "")}\\`);
}

function realOf(deps: Pick<WindowsUninstallDeps, "realpath">, path: string): string {
  try {
    return strip(deps.realpath(path));
  } catch {
    return strip(win32.resolve(path));
  }
}

/**
 * Why `path` may not be moved to the Recycle Bin as the data folder, or null when it may: it must
 * be an absolute local path that resolves strictly inside the profile folder (so never the
 * profile, a drive, a share or the system folders), not be one of the personal folders, and carry
 * a Psyche marker.
 */
export function dataFolderProblemWindows(
  path: string | undefined,
  userProfile: string,
  deps: Pick<WindowsUninstallDeps, "realpath" | "exists">,
): string | null {
  if (path === undefined || path === "") return "no data folder is set";
  if (!win32.isAbsolute(path) || /^[\\/](?![\\/])/.test(path)) {
    return "it is not an absolute path";
  }
  const p = realOf(deps, path);
  const h = realOf(deps, userProfile);
  if (p.startsWith("\\\\")) return "it is on a network share";
  if (/^[A-Za-z]:\\?$/.test(p)) return "it is a drive root";
  if (lower(p) === lower(h)) return "it is your user folder";
  if (!lower(p).startsWith(`${lower(h)}\\`)) return "it is not inside your user folder";
  for (const d of PERSONAL_FOLDERS) {
    if (lower(p) === lower(win32.join(h, d))) return `it is your ${d} folder`;
  }
  if (!DATA_MARKERS_WINDOWS.some((m) => deps.exists(win32.join(p, m)))) {
    return "it has no Psyche marker (state\\psyche.sqlite or config.json)";
  }
  return null;
}

/** Why `path` cannot be moved to the Recycle Bin right now, or null. */
export function recycleProblem(
  path: string,
  deps: Pick<WindowsUninstallDeps, "realpath" | "canModify">,
): string | null {
  const r = realOf(deps, path);
  if (r.startsWith("\\\\")) {
    return "it is on a network location, which has no Recycle Bin; remove it from File Explorer";
  }
  if (!deps.canModify(win32.dirname(r))) {
    return "its folder is read-only or not yours to change; remove it from File Explorer";
  }
  return null;
}

/**
 * The targets in `cmdkey /list` output that start with `Psyche/`. Only the `target=` part is read:
 * the rest of each line is in the Windows display language.
 */
export function parseCmdkeyTargets(stdout: string): string[] {
  const out = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = /target=(.+?)\s*$/i.exec(line);
    const target = m?.[1];
    if (target?.startsWith(CREDENTIAL_PREFIX) && safeTarget(target)) {
      out.add(target);
    }
  }
  return [...out].sort();
}

/** A target main will pass to `cmdkey /delete:`: Psyche's prefix, one line, no quotes. */
export function safeTarget(target: string): boolean {
  return (
    target.startsWith(CREDENTIAL_PREFIX) &&
    target.length > CREDENTIAL_PREFIX.length &&
    ![...target].some((c) => c === '"' || c.charCodeAt(0) < 0x20)
  );
}

function dataFolderOf(deps: WindowsUninstallDeps): { folder: string; warnings: string[] } {
  const warnings: string[] = [];
  const env = deps.psycheHome === "" ? undefined : deps.psycheHome;
  const agent = deps.agentPsycheHome === "" ? undefined : deps.agentPsycheHome;
  if (agent !== undefined) {
    if (env !== undefined && lower(realOf(deps, env)) !== lower(realOf(deps, agent))) {
      warnings.push(
        `PSYCHE_HOME (${env}) differs from the folder the Gateway task uses (${agent}); using the task's`,
      );
    }
    return { folder: agent, warnings };
  }
  return { folder: env ?? win32.join(deps.userProfile, ".psyche"), warnings };
}

/** The per-user folders the app, the Gateway and the helper keep outside `~\.psyche`. */
function userFolders(deps: WindowsUninstallDeps): UninstallItem[] {
  const item = (kind: UninstallItemKind, path: string, label: string): UninstallItem => ({
    kind,
    path,
    label,
  });
  const roaming = (n: string) => win32.join(deps.appData, n);
  const local = (n: string) => win32.join(deps.localAppData, n);
  return [
    item("support", deps.userDataDir, "Settings, web storage, caches and logs"),
    item("support", roaming("com.psyche.helper"), "Helper settings"),
    item("cache", local("com.psyche.helper"), "Helper caches"),
    item("cache", local("Psyche Helper"), "Helper caches"),
    item("cache", local("com.psyche.gateway"), "Gateway caches"),
    ...(deps.installRoot === null
      ? []
      : [item("cache", win32.join(deps.installRoot, "vm-images"), "Sandbox PC image")]),
  ];
}

/** What uninstalling would do, from what exists right now. Nothing is changed. */
export async function planUninstallWindows(
  deps: WindowsUninstallDeps,
  opts: PlanOptions,
): Promise<WindowsUninstallPlan> {
  if (deps.installRoot === null || deps.updateExe === null) {
    throw new UninstallError(
      "forbidden",
      "This copy of Psyche was not installed by the Windows installer, so it cannot remove itself. Remove it from Settings › Apps › Installed apps, or delete the folder you extracted it to.",
    );
  }
  const root = realOf(deps, deps.installRoot);
  if (
    win32.basename(root).toLowerCase() !== "psyche" ||
    !isInside(deps.localAppData, root) ||
    lower(root) === lower(deps.localAppData)
  ) {
    throw new UninstallError(
      "forbidden",
      `Psyche is installed in ${deps.installRoot}, not in a Psyche folder under ${deps.localAppData}, so it will not remove it. Remove it from Settings › Apps › Installed apps.`,
    );
  }
  const exists = deps.exists;
  const warnings: string[] = [];
  const stops: UninstallItem[] = [
    {
      kind: "helper",
      path: "",
      label: "Stop Psyche Helper, turn off open at login and remove its notification keys",
    },
  ];
  const tasks = await deps.gatewayTasks();
  const ours = tasks.filter((t) => t.owner === "ours").map((t) => t.name);
  const others = tasks.filter((t) => t.owner === "other");
  if (ours.length > 0) {
    stops.unshift({
      kind: "agent",
      path: "",
      label: `Stop and delete the scheduled task ${ours.join(" and ")}`,
    });
  }
  for (const t of others) {
    warnings.push(
      `The scheduled task ${t.name} runs another copy of Psyche or the command-line tool; it is left alone`,
    );
  }
  if (deps.sid === null) {
    warnings.push(
      "Windows did not say which account this is (whoami /user), so the Gateway task and the sandbox PC service cannot be looked up",
    );
  }
  let sandboxPc: WindowsUninstallPlan["sandboxPc"];
  if (deps.sid !== null) {
    const service = `PsycheVM-${deps.sid}`;
    const q = await deps.run("sc.exe", ["query", service]);
    if (q.code !== SERVICE_NOT_INSTALLED) {
      sandboxPc = { service, sid: deps.sid };
      stops.push({
        kind: "service",
        path: "",
        label: `Remove the sandbox PC service ${service} (one administrator prompt)`,
      });
    }
  }
  const { folder, warnings: w } = dataFolderOf(deps);
  warnings.push(...w);
  const trash = userFolders(deps).filter((i) => exists(i.path));
  const blockers: { path: string; reason: string }[] = [];
  let dataFolder: string | undefined;
  if (opts.deleteData) {
    const problem = dataFolderProblemWindows(folder, deps.userProfile, deps);
    if (problem !== null) {
      throw new UninstallError(
        "forbidden",
        `Psyche will not move ${folder} to the Recycle Bin: ${problem}. Move your data folder to the Recycle Bin from File Explorer if you want it gone.`,
      );
    }
    dataFolder = realOf(deps, folder);
    if (exists(dataFolder)) trash.push({ kind: "data", path: dataFolder, label: "Psyche data" });
  }
  trash.push({ kind: "app", path: root, label: "Psyche (removed by the Windows uninstaller)" });
  for (const item of trash) {
    if (item.kind === "app") continue;
    const reason = recycleProblem(item.path, deps);
    if (reason !== null) blockers.push({ path: item.path, reason });
  }
  const keychain = opts.deleteData && opts.removeKeychain === true ? await credentials(deps) : [];
  return {
    stops,
    trash,
    deleteData: opts.deleteData,
    ...(dataFolder === undefined ? {} : { dataFolder }),
    agent: ours.length > 0 ? "ours" : others.length > 0 ? "other" : "none",
    keychain,
    warnings,
    blockers,
    tasks: ours,
    home: realOf(deps, folder),
    ...(sandboxPc === undefined ? {} : { sandboxPc }),
  };
}

async function credentials(deps: WindowsUninstallDeps): Promise<string[]> {
  return (await deps.credentialTargets()).filter(safeTarget);
}

function sandboxPcManualSteps(service: string): string {
  return [
    "Psyche's sandbox PC service is still registered with Windows. To remove it, open Windows Terminal as an administrator and run:",
    "",
    `  sc.exe stop ${service}`,
    `  sc.exe delete ${service}`,
    "",
  ].join("\r\n");
}

/**
 * Runs the uninstall. Everything that can refuse does so before anything is stopped: the typed
 * word, the data-folder rules, the pre-flight of every target, the Gateway's presence gate and the
 * native confirmation.
 */
export async function runUninstallWindows(
  deps: WindowsUninstallDeps,
  req: UninstallRequest,
): Promise<WindowsUninstallResult> {
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (req.deleteData && req.confirm !== DELETE_CONFIRM_WORD) {
    throw new UninstallError("invalid_params", `Type ${DELETE_CONFIRM_WORD} to delete your data`);
  }
  const plan = await planUninstallWindows(deps, req);
  if (plan.blockers.length > 0) {
    throw new UninstallError(
      "unavailable",
      `Nothing was changed. These cannot be moved to the Recycle Bin from here: ${plan.blockers
        .map((b) => `${b.path} (${b.reason})`)
        .join("; ")}. ${UNINSTALL_MANUAL_STEPS_WINDOWS}`,
    );
  }
  if (req.deleteData && plan.dataFolder !== undefined) {
    await deps.authorizeDelete(plan.dataFolder, req.approvalId);
  }
  if (!(await deps.confirm(plan))) throw new UninstallError("cancelled", "Uninstall cancelled");

  const manual: string[] = [];
  const trashed: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  const trash = async (path: string): Promise<boolean> => {
    try {
      await deps.trashItem(path);
      trashed.push(path);
      log(`moved to the Recycle Bin: ${path}`);
      return true;
    } catch (err) {
      failed.push({ path, reason: String(err) });
      log(`could not move ${path} to the Recycle Bin: ${String(err)}`);
      return false;
    }
  };

  // 1. The sandbox PC service first, while the Gateway still runs: one UAC prompt. A dismissed
  //    prompt (or an account that cannot elevate) is not a reason to keep Psyche installed: the
  //    steps are written down and shown, and the owner finishes them by hand.
  if (plan.sandboxPc !== undefined) {
    const { service, sid } = plan.sandboxPc;
    let done = false;
    try {
      done = (await deps.elevatedServiceUninstall(sid)).ok;
    } catch (err) {
      log(`the sandbox PC service could not be removed: ${String(err)}`);
    }
    if (done) {
      const q = await deps.run("sc.exe", ["query", service]);
      done = q.code === SERVICE_NOT_INSTALLED;
    }
    if (!done) {
      const text = sandboxPcManualSteps(service);
      const file = deps.writeNote(text);
      manual.push(`${text}\r\n(Also saved to ${file}.)`);
    }
  }

  // 2. Stop what could put things back: the updater, the staged update, open at login, the
  //    handlers and toast keys, the helper.
  const staged = await deps.clearStagedUpdate().catch(() => [] as string[]);
  for (const path of staged) await trash(path);
  deps.setOpenAtLogin(false);
  for (const e of uninstallRegistryEntries()) {
    await deps
      .run("reg.exe", ["delete", e.key, ...(e.value === undefined ? [] : ["/v", e.value]), "/f"])
      .catch(() => undefined);
  }
  await deps.stopHelper().catch(() => undefined);

  // 3. The Gateway task: end it, end its processes, delete it. A Gateway that will not stop, or a
  //    task that will not go, leaves everything as it was.
  let stoppedAgent = false;
  if (plan.tasks.length > 0) {
    for (const task of plan.tasks) await deps.run("schtasks.exe", [...schtasks.end(task)]);
    const alive = (): number[] => deps.gatewayPids(plan.home).filter((p) => deps.pidAlive(p));
    for (const pid of alive()) {
      await deps.run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    }
    for (let i = 0; alive().length > 0 && i < 20; i++) await sleep(500);
    let reason = alive().length > 0 ? "the Gateway would not stop" : null;
    if (reason === null) {
      for (const task of plan.tasks) {
        await deps.run("schtasks.exe", [...schtasks.delete(task)]);
        if ((await deps.run("schtasks.exe", [...schtasks.query(task)])).code === 0) {
          reason = `the scheduled task ${task} would not delete`;
          break;
        }
      }
    }
    if (reason !== null) {
      const restarted = await deps.restartAgent().then(
        () => true,
        () => false,
      );
      throw new UninstallError(
        "unavailable",
        `${reason[0]?.toUpperCase()}${reason.slice(1)}, so nothing was moved. ${restarted ? "The Gateway is running again." : "Restart Psyche to start it again."}`,
      );
    }
    stoppedAgent = true;
  }

  // 4. Move to the Recycle Bin. Chromium keeps its user data open while this process runs, so
  //    that folder waits for the finisher; the app itself is Squirrel's.
  const deferred: string[] = [];
  let dataTrashed = false;
  for (const item of plan.trash) {
    if (item.kind === "app") continue;
    if (isInside(deps.userDataDir, item.path)) {
      deferred.push(item.path);
      continue;
    }
    const ok = await trash(item.path);
    if (item.kind === "data" && ok) dataTrashed = true;
  }
  if (dataTrashed && req.removeKeychain === true) {
    for (const target of plan.keychain.filter(safeTarget)) {
      const r = await deps.run("cmdkey.exe", [`/delete:${target}`]);
      if (r.code !== 0) {
        failed.push({ path: `Credential Manager item ${target}`, reason: `cmdkey exit ${r.code}` });
      }
    }
  }
  if (failed.length > 0) {
    // Something is half-done: keep the app open so the owner can see it, and bring the Gateway
    // back unless its data is already in the Recycle Bin.
    let restarted = false;
    if (stoppedAgent && !dataTrashed) {
      restarted = await deps.restartAgent().then(
        () => true,
        () => false,
      );
    }
    return { trashed, failed, restarted, deferred, manual };
  }

  // 5. Hand over: the finisher waits for this process to exit, moves the user data folder, then
  //    runs Update.exe --uninstall (which removes the app folder and runs the uninstall hook).
  if (manual.length > 0) await deps.showManualSteps(manual.join("\r\n\r\n")).catch(() => undefined);
  deps.closeWindows();
  try {
    deps.startFinisher(deferred, deps.updateExe as string);
  } catch (err) {
    failed.push({ path: deps.installRoot as string, reason: String(err) });
    return { trashed, failed, restarted: false, deferred, manual };
  }
  deps.quit();
  return { trashed, failed, restarted: false, deferred, manual };
}

/**
 * The finisher's whole command text: a constant, never built from arguments. The paths travel in
 * the environment (`PSYCHE_TRASH_PATHS`, a JSON array; `PSYCHE_UPDATE_EXE`; `PSYCHE_WAIT_PID`), so
 * nothing in a path can be parsed as PowerShell code.
 */
export const FINISH_SCRIPT = [
  "$ErrorActionPreference = 'Continue'",
  "$failed = @()",
  "try { Wait-Process -Id ([int]$env:PSYCHE_WAIT_PID) -Timeout 60 -ErrorAction SilentlyContinue } catch {}",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "foreach ($p in @(ConvertFrom-Json -InputObject $env:PSYCHE_TRASH_PATHS)) {",
  "  try {",
  "    if (Test-Path -LiteralPath $p -PathType Container) {",
  "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  "    } elseif (Test-Path -LiteralPath $p) {",
  "      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')",
  "    }",
  "  } catch { $failed += $p }",
  "}",
  "try { Start-Process -FilePath $env:PSYCHE_UPDATE_EXE -ArgumentList '--uninstall' -Wait } catch { $failed += $env:PSYCHE_UPDATE_EXE }",
  "if ($failed.Count -gt 0) {",
  "  $note = Join-Path $env:TEMP 'Psyche-uninstall-leftovers.txt'",
  '  $text = "Psyche could not finish removing these. Move them to the Recycle Bin in File Explorer, and remove Psyche in Settings > Apps > Installed apps if it is still listed:`r`n`r`n" + ($failed -join "`r`n")',
  "  Set-Content -LiteralPath $note -Value $text",
  "  (New-Object -ComObject WScript.Shell).Popup($text, 0, 'Psyche', 48) | Out-Null",
  "}",
].join("\n");

/** Starts the finisher detached, so it outlives this process. */
export function spawnFinisher(
  deferred: readonly string[],
  updateExe: string,
  opts: { systemRoot?: string; env?: NodeJS.ProcessEnv; pid?: number } = {},
): void {
  const systemRoot = opts.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const ps = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", FINISH_SCRIPT], {
    env: {
      ...(opts.env ?? process.env),
      PSYCHE_TRASH_PATHS: JSON.stringify(deferred),
      PSYCHE_UPDATE_EXE: updateExe,
      PSYCHE_WAIT_PID: String(opts.pid ?? process.pid),
      // The Squirrel hook then leaves the sandbox PC service alone: it was dealt with above.
      [SANDBOX_PC_HANDLED_ENV]: "1",
    },
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}

/** The helper of this install folder, ended by path so another copy's helper keeps running. */
export const STOP_HELPER_SCRIPT = [
  "$root = $env:PSYCHE_INSTALL_ROOT.TrimEnd('\\') + '\\'",
  "Get-CimInstance Win32_Process -Filter \"Name = 'psyche-helper.exe'\" |",
  "  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } |",
  "  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
].join("\n");

/** The text of the native confirmation main shows (every item is listed in the sheet already). */
export function confirmDetailWindows(plan: WindowsUninstallPlan): string {
  const bin = plan.trash.filter((i) => i.kind !== "app").length;
  return [
    `${bin} item(s) will be moved to the Recycle Bin, and Psyche will be removed the way Settings › Apps would.`,
    plan.deleteData && plan.dataFolder !== undefined
      ? `Your data folder ${plan.dataFolder} will be moved to the Recycle Bin too.`
      : "Your data folder is kept.",
    plan.sandboxPc !== undefined
      ? "Windows will ask for administrator approval to remove the sandbox PC service."
      : "",
    plan.keychain.length > 0
      ? `${plan.keychain.length} Credential Manager item(s) that Psyche keeps will be removed.`
      : "Credential Manager items stay; remove them in Credential Manager if you want.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
