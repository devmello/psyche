import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type AgentOwner,
  DELETE_CONFIRM_WORD,
  dataFolderProblem,
  type PlanOptions,
  type UninstallItem,
  UninstallError,
  type UninstallPlan,
  type UninstallRequest,
  type UninstallResult,
} from "../main/uninstall.ts";
import type { Runner } from "../main/supervisor-base.ts";
import { autostartPath } from "./autostart.ts";
import type { LinuxInstallKind, LinuxPackageManager } from "./install-kind.ts";
import { fillText, type LinuxUninstallText, linuxUninstallText } from "./linux-text.ts";
import { systemctlUser } from "./systemd-supervisor.ts";
import { GATEWAY_UNIT, HELPER_UNIT, parseGatewayUnit, userUnitDir } from "./systemd-unit.ts";

/**
 * Uninstall Psyche on Linux (design §2.5), the twin of `main/uninstall.ts` (macOS) and
 * `main/uninstall-windows.ts`, behind the same Settings › About sheet. Same order and same
 * guarantees: everything that can refuse does so before anything is stopped (the typed word, the
 * data-folder rules, a pre-flight of every target, the Gateway's presence gate, the native
 * confirmation); user files go to the Trash (`shell.trashItem` is `gio trash`), never `rm -rf`;
 * the app quits only when every step worked.
 *
 * - Always: `systemctl --user disable --now psyche-gateway.service`, stop the helper and Psyche's
 *   containers (matched by the `com.psyche.owner=1` label only), remove the unit files and the
 *   autostart and launcher entries Psyche wrote, trash the settings, caches, helper state and the
 *   previous version kept for rollback.
 * - AppImage: the image itself goes to the Trash.
 * - deb/rpm: the sheet shows the exact command (`sudo apt remove psyche`) and runs it through
 *   `pkexec` last. The package's `prerm` does nothing to user data.
 * - "Also delete my Psyche data" is a checkbox, off by default, with the Gateway's presence gate.
 */

export const LINUX_PACKAGE_NAME = "psyche";
/** Containers Psyche starts carry this label (design §8.4). */
export const OWNER_LABEL = "com.psyche.owner=1";

export interface LinuxUninstallDeps {
  userHome: string;
  /** XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_STATE_HOME, XDG_DATA_HOME. */
  env: NodeJS.ProcessEnv;
  /** `$PSYCHE_HOME` as this app resolved it (an empty value counts as unset). */
  psycheHome: string | undefined;
  /** PSYCHE_HOME written in the installed unit, which wins when present. */
  unitPsycheHome?: string | undefined;
  install: LinuxInstallKind;
  /** `$APPIMAGE`, or null for a package. */
  appImagePath: string | null;
  /** Which package manager owns the install (deb/rpm only). */
  packageManager: LinuxPackageManager | undefined;
  /** The OS locale, for the sheet's words. */
  locale: string;
  exists?: (path: string) => boolean;
  run: Runner;
  /** Electron `shell.trashItem`. */
  trashItem: (path: string) => Promise<void>;
  /** Removes a file or folder Psyche itself wrote (a unit, an autostart entry). */
  removePath: (path: string) => void;
  setOpenAtLogin: (value: boolean) => void;
  /** Whether the unit runs this app's psyched, another copy's or the CLI's, or is absent. */
  unitOwner: () => AgentOwner;
  /** True while systemd still reports the Gateway unit active. */
  unitActive: () => Promise<boolean>;
  /** Starts the Gateway again (`supervisor.ensureRunning()`). */
  restartGateway: () => Promise<void>;
  /** Stops the updater and clears a staged update so nothing reinstalls the app or the data. */
  clearStagedUpdate: () => Promise<string[]>;
  /** Asks the Gateway for fresh presence for exactly this folder; throws `approval_required`. */
  authorizeDelete: (dataFolder: string, approvalId: string | undefined) => Promise<void>;
  /** A native confirmation main shows before anything is stopped. */
  confirm: (plan: LinuxUninstallPlan) => Promise<boolean>;
  closeWindows: () => void;
  quit: () => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export interface LinuxUninstallPlan extends UninstallPlan {
  /** Files Psyche wrote that are deleted, not trashed (units, autostart and launcher entries). */
  remove: UninstallItem[];
  /** deb/rpm: the command the sheet shows and `pkexec` runs. */
  packageCommand?: string;
}

export interface LinuxUninstallResult extends UninstallResult {
  /** deb/rpm: the package manager's answer when it did not remove the package. */
  packageFailed?: string;
}

export const UNINSTALL_MANUAL_STEPS_LINUX =
  "Finish by hand: move the listed items to the Trash in your file manager, then remove the Psyche app (delete the AppImage, or remove the package).";

/** The command shown to the owner. */
export function packageRemoveCommand(pm: LinuxPackageManager): string {
  return pm === "apt"
    ? `sudo apt remove ${LINUX_PACKAGE_NAME}`
    : `sudo dnf remove ${LINUX_PACKAGE_NAME}`;
}

/** The same removal as `pkexec` runs it: non-interactive, no shell. */
export function packageRemoveArgv(pm: LinuxPackageManager): [string, string[]] {
  return pm === "apt"
    ? ["pkexec", ["apt-get", "remove", "-y", LINUX_PACKAGE_NAME]]
    : ["pkexec", ["dnf", "remove", "-y", LINUX_PACKAGE_NAME]];
}

/** `PSYCHE_HOME` from an installed unit or drop-in (`Environment="PSYCHE_HOME=..."`). */
export function psycheHomeFromUnit(text: string): string | undefined {
  return parseGatewayUnit(`ExecStart=x\n${text}`)?.env.PSYCHE_HOME || undefined;
}

/**
 * Who owns the Gateway unit. A package's unit is always ours (the package installed it). An
 * AppImage writes its own unit to the user directory: ours when it runs this image, another copy's
 * (or the CLI's) otherwise.
 */
export function linuxUnitOwner(o: {
  install: LinuxInstallKind;
  unitFile: string;
  program: string;
  exists?: (path: string) => boolean;
  read?: (path: string) => string;
}): AgentOwner {
  const exists = o.exists ?? existsSync;
  if (o.install === "package") return "ours";
  if (!exists(o.unitFile)) return "none";
  const read = o.read ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    return parseGatewayUnit(read(o.unitFile))?.program === o.program ? "ours" : "other";
  } catch {
    return "other";
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Why `path` cannot be moved to the Trash right now, or null: its folder must be ours to change. */
export function linuxTrashProblem(path: string): string | null {
  try {
    accessSync(dirname(real(path)), constants.W_OK);
  } catch {
    return "its folder is read-only or not yours to change; remove it from your file manager";
  }
  return null;
}

function xdg(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const v = env[name];
  return v !== undefined && v !== "" && isAbsolute(v) ? v : fallback;
}

/** The folders and files the app keeps outside `~/.psyche` (design §2.2 and §2.5). */
function linuxPaths(deps: LinuxUninstallDeps, t: LinuxUninstallText, unitOurs: boolean) {
  const { userHome, env } = deps;
  const config = xdg(env, "XDG_CONFIG_HOME", join(userHome, ".config"));
  const cache = xdg(env, "XDG_CACHE_HOME", join(userHome, ".cache"));
  const state = xdg(env, "XDG_STATE_HOME", join(userHome, ".local", "state"));
  const data = xdg(env, "XDG_DATA_HOME", join(userHome, ".local", "share"));
  const units = userUnitDir(env, userHome);
  const item = (kind: UninstallItem["kind"], path: string, label: string): UninstallItem => ({
    kind,
    path,
    label,
  });
  const remove = [
    ...(unitOurs
      ? [
          item("agent", join(units, GATEWAY_UNIT), t.itemService),
          item("agent", join(units, `${GATEWAY_UNIT}.d`), t.itemService),
        ]
      : []),
    item("agent", join(units, HELPER_UNIT), t.itemService),
    item("service", autostartPath(env, userHome), t.itemAutostart),
    item("service", join(data, "applications", "psyche.desktop"), t.itemLauncher),
  ];
  const trash = [
    item("support", join(config, "Psyche"), t.itemSettings),
    item("cache", join(cache, "psyche"), t.itemCaches),
    item("state", join(state, "psyche-helper"), t.itemHelperState),
    item("cache", join(data, "psyche", "previous"), t.itemPrevious),
  ];
  return { remove, trash };
}

function dataFolderOf(deps: LinuxUninstallDeps): { folder: string; warnings: string[] } {
  const warnings: string[] = [];
  const env = deps.psycheHome === "" ? undefined : deps.psycheHome;
  const unit = deps.unitPsycheHome === "" ? undefined : deps.unitPsycheHome;
  if (unit !== undefined) {
    if (env !== undefined && real(env) !== real(unit)) {
      warnings.push(
        `PSYCHE_HOME (${env}) differs from the folder the Gateway service uses (${unit}); using the service's`,
      );
    }
    return { folder: unit, warnings };
  }
  return { folder: env ?? join(deps.userHome, ".psyche"), warnings };
}

/** What uninstalling would do, from what exists right now. Pure: nothing is changed. */
export function planUninstallLinux(
  deps: LinuxUninstallDeps,
  opts: PlanOptions,
): LinuxUninstallPlan {
  const exists = deps.exists ?? existsSync;
  const t = linuxUninstallText(deps.locale);
  const owner = deps.unitOwner();
  const warnings: string[] = [];
  const stops: UninstallItem[] = [
    { kind: "helper", path: "", label: t.stopHelper },
    { kind: "service", path: "", label: t.stopDesktops },
  ];
  if (owner === "ours") stops.unshift({ kind: "agent", path: "", label: t.stopGateway });
  else if (owner === "other") warnings.push(t.warnOtherUnit);

  const { remove: removeAll, trash: trashAll } = linuxPaths(deps, t, owner === "ours");
  const remove = removeAll.filter((i) => exists(i.path));
  const trash = trashAll.filter((i) => exists(i.path));
  const blockers: { path: string; reason: string }[] = [];

  let packageCommand: string | undefined;
  if (deps.install === "package") {
    if (deps.packageManager === undefined) {
      throw new UninstallError(
        "forbidden",
        "Psyche could not find which package manager installed this copy, so it cannot remove itself. Remove the psyche package with your package manager.",
      );
    }
    packageCommand = packageRemoveCommand(deps.packageManager);
    warnings.push(fillText(t.warnPackage, { command: packageCommand }));
  } else if (deps.appImagePath !== null && exists(deps.appImagePath)) {
    if (!isAbsolute(deps.appImagePath) || !/\.appimage$/i.test(basename(deps.appImagePath))) {
      throw new UninstallError(
        "forbidden",
        `This copy is ${deps.appImagePath}, which is not an .AppImage file, so Psyche will not move it. Move it to the Trash from your file manager.`,
      );
    }
    trash.push({ kind: "app", path: deps.appImagePath, label: t.itemApp });
  }

  let dataFolder: string | undefined;
  if (opts.deleteData) {
    const { folder, warnings: w } = dataFolderOf(deps);
    warnings.push(...w);
    const problem = dataFolderProblem(folder, deps.userHome);
    if (problem !== null) {
      throw new UninstallError(
        "forbidden",
        `Psyche will not move ${folder} to the Trash: ${problem}. Move your data folder to the Trash from your file manager if you want it gone.`,
      );
    }
    dataFolder = real(folder);
    if (exists(dataFolder)) trash.push({ kind: "data", path: dataFolder, label: t.itemData });
  }
  for (const item of trash) {
    const reason = linuxTrashProblem(item.path);
    if (reason !== null) blockers.push({ path: item.path, reason });
  }
  return {
    stops,
    trash,
    remove,
    deleteData: opts.deleteData,
    ...(dataFolder === undefined ? {} : { dataFolder }),
    ...(packageCommand === undefined ? {} : { packageCommand }),
    agent: owner,
    keychain: [],
    warnings,
    blockers,
  };
}

/** The native confirmation's body and button labels, in the OS language. */
export function confirmTextLinux(
  plan: LinuxUninstallPlan,
  locale: string,
): { title: string; detail: string; cancel: string; confirm: string } {
  const t = linuxUninstallText(locale);
  return {
    title: t.confirmTitle,
    cancel: t.confirmCancel,
    confirm: plan.deleteData ? t.confirmDeleteData : t.confirmUninstall,
    detail: [
      fillText(t.confirmItems, { count: plan.trash.length }),
      plan.deleteData && plan.dataFolder !== undefined
        ? fillText(t.confirmDataTrashed, { folder: plan.dataFolder })
        : t.confirmDataKept,
      ...(plan.packageCommand === undefined ? [] : [t.confirmPackage, plan.packageCommand]),
    ].join("\n"),
  };
}

/**
 * Runs the uninstall. Everything that can refuse does so before anything is stopped; on a failure
 * the Gateway is started again unless its data is already in the Trash, and the failed paths are
 * reported with the steps to finish by hand.
 */
export async function runUninstallLinux(
  deps: LinuxUninstallDeps,
  req: UninstallRequest,
): Promise<LinuxUninstallResult> {
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t = linuxUninstallText(deps.locale);
  if (req.deleteData && req.confirm !== DELETE_CONFIRM_WORD) {
    throw new UninstallError("invalid_params", `Type ${DELETE_CONFIRM_WORD} to delete your data`);
  }
  const plan = planUninstallLinux(deps, req);
  if (plan.blockers.length > 0) {
    throw new UninstallError(
      "unavailable",
      `Nothing was changed. These cannot be moved to the Trash from here: ${plan.blockers
        .map((b) => `${b.path} (${b.reason})`)
        .join("; ")}. ${UNINSTALL_MANUAL_STEPS_LINUX}`,
    );
  }
  if (req.deleteData && plan.dataFolder !== undefined) {
    await deps.authorizeDelete(plan.dataFolder, req.approvalId);
  }
  if (!(await deps.confirm(plan))) throw new UninstallError("cancelled", "Uninstall cancelled");

  const trashed: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  const trash = async (path: string): Promise<boolean> => {
    try {
      await deps.trashItem(path);
      trashed.push(path);
      log(`moved to the Trash: ${path}`);
      return true;
    } catch (err) {
      failed.push({ path, reason: String(err) });
      log(`could not move ${path} to the Trash: ${String(err)}`);
      return false;
    }
  };

  // 1. Stop what could put things back: the updater and a staged update, open at login, the
  //    helper, Psyche's containers, then the Gateway unit.
  for (const path of await deps.clearStagedUpdate().catch(() => [] as string[])) await trash(path);
  deps.setOpenAtLogin(false);
  await deps.run("systemctl", systemctlUser.stop(HELPER_UNIT)).catch(() => undefined);
  await deps
    .run("podman", ["rm", "-f", "--filter", `label=${OWNER_LABEL}`])
    .catch(() => undefined);
  let stoppedGateway = false;
  if (plan.agent === "ours") {
    const out = await deps.run("systemctl", systemctlUser.disableNow());
    // Already stopped is fine; anything else must really have stopped.
    let active = await deps.unitActive();
    for (let i = 0; active && i < 20; i++) {
      await sleep(500);
      active = await deps.unitActive();
    }
    if (active) {
      const restarted = await deps.restartGateway().then(
        () => true,
        () => false,
      );
      throw new UninstallError(
        "unavailable",
        `The Gateway service would not stop (systemctl exit ${out.code}), so nothing was moved. ${restarted ? "It is still running." : "Restart Psyche to start it again."}`,
      );
    }
    stoppedGateway = true;
  }

  // 2. Remove what Psyche wrote (units, autostart, launcher), then move the rest to the Trash.
  //    The data folder needs the Gateway gone (checked above); the app goes last.
  let removedUnit = false;
  for (const item of plan.remove) {
    try {
      deps.removePath(item.path);
      log(`removed: ${item.path}`);
      if (item.kind === "agent") removedUnit = true;
    } catch (err) {
      failed.push({ path: item.path, reason: String(err) });
    }
  }
  if (removedUnit) await deps.run("systemctl", systemctlUser.daemonReload()).catch(() => undefined);
  let dataTrashed = false;
  for (const item of plan.trash.filter((i) => i.kind !== "app")) {
    const ok = await trash(item.path);
    if (item.kind === "data" && ok) dataTrashed = true;
  }
  if (failed.length > 0) {
    let restarted = false;
    if (stoppedGateway && !dataTrashed) {
      restarted = await deps.restartGateway().then(
        () => true,
        () => false,
      );
    }
    return { trashed, failed, restarted };
  }

  // 3. The app. An AppImage is trashed; a package is removed by the package manager after one
  //    administrator prompt (pkexec shows the polkit dialog).
  deps.closeWindows();
  for (const item of plan.trash.filter((i) => i.kind === "app")) {
    if (!(await trash(item.path))) return { trashed, failed, restarted: false };
  }
  if (plan.packageCommand !== undefined && deps.packageManager !== undefined) {
    const [file, args] = packageRemoveArgv(deps.packageManager);
    const res = await deps.run(file, args);
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout).trim().split("\n").pop() || `exit ${res.code}`;
      const packageFailed = fillText(t.packageFailed, { detail, command: plan.packageCommand });
      failed.push({ path: plan.packageCommand, reason: detail });
      return { trashed, failed, restarted: false, packageFailed };
    }
  }
  deps.quit();
  return { trashed, failed, restarted: false };
}
