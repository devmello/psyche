import { accessSync, constants, existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { LAUNCH_AGENT_LABEL, launchctl, type Runner } from "./supervisor.ts";

/**
 * Uninstall Psyche (docs/design/updates-and-install-2026.md section 3.5), driven from Settings →
 * About. Main-process only: the IPC channels are in `REMOTE_REFUSED_CHANNELS` and are only
 * registered for a packaged app that runs its own Gateway LaunchAgent. "Delete my data" needs the
 * owner's fresh presence (`app.uninstall.authorize` on the Gateway, naming the exact folder) plus a
 * typed word. Everything is moved to the Trash with Electron's `shell.trashItem`, never `rm -rf`.
 * Every outside effect comes in through `UninstallDeps`, so tests run it on temporary paths with
 * fakes.
 *
 * Order: check everything first (nothing is stopped until every target can be moved), ask in a
 * native dialog, stop the updater, the helper and the agent, move things to the Trash, and quit
 * only when every step worked. On a failure the Gateway agent is started again and the failed
 * paths are reported with the steps to finish by hand.
 */

/** The word the owner types to confirm deleting their data. */
export const DELETE_CONFIRM_WORD = "DELETE";

/** Keychain services the vault and the helper keep; removed only with the data, on request. */
export const KEYCHAIN_SERVICES: readonly string[] = [
  "com.psyche.vault",
  "com.psyche.helper.items",
  "com.psyche.helper.identity",
  "com.psyche.helper.probe",
];

export type UninstallItemKind = "agent" | "helper" | "support" | "cache" | "app" | "data" | "state";

export interface UninstallItem {
  kind: UninstallItemKind;
  /** Absolute path; empty for things that are stopped rather than removed. */
  path: string;
  label: string;
}

/** Who owns the `com.psyche.gateway` LaunchAgent. */
export type AgentOwner = "ours" | "other" | "none";

export interface UninstallPlan {
  /** What is stopped or unregistered. */
  stops: UninstallItem[];
  /** What is moved to the Trash, in order. Only paths that exist. */
  trash: UninstallItem[];
  deleteData: boolean;
  /** The resolved data folder when it is part of the plan. */
  dataFolder?: string;
  agent: AgentOwner;
  /** Keychain services that will be removed (only with the data, only when asked). */
  keychain: string[];
  /** Things the owner should know (a PSYCHE_HOME that differs from the agent's, and so on). */
  warnings: string[];
  /** Why this cannot run right now, with the manual steps; empty when it can. */
  blockers: { path: string; reason: string }[];
}

export interface UninstallDeps {
  userHome: string;
  /** `$PSYCHE_HOME` as this app resolved it (an empty value counts as unset). */
  psycheHome: string | undefined;
  /** PSYCHE_HOME written in the installed LaunchAgent plist, which wins when present. */
  agentPsycheHome?: string | undefined;
  /** The installed bundle, or null for an unpackaged build (nothing is moved then). */
  appBundlePath: string | null;
  helperAppPath: string | null;
  uid: number;
  exists?: (path: string) => boolean;
  run: Runner;
  /** Electron `shell.trashItem`. */
  trashItem: (path: string) => Promise<void>;
  setOpenAtLogin: (value: boolean) => void;
  /** Whether the agent plist runs this app's psyched, another copy's or the CLI's, or is absent. */
  agentOwner: () => AgentOwner;
  /** True while `launchctl print` still finds the job. */
  agentLoaded: () => Promise<boolean>;
  /** Starts the Gateway again (`supervisor.ensureRunning()`). */
  restartAgent: () => Promise<void>;
  /** Stops the updater and clears a staged update so nothing reinstalls the app or the data. */
  clearStagedUpdate: () => Promise<string[]>;
  /** Asks the Gateway for fresh presence for exactly this folder; throws `approval_required`. */
  authorizeDelete: (dataFolder: string, approvalId: string | undefined) => Promise<void>;
  /** A native confirmation main shows before anything is stopped. */
  confirm: (plan: UninstallPlan) => Promise<boolean>;
  /** Closes the app's windows so Saved Application State is not written again. */
  closeWindows: () => void;
  quit: () => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export type UninstallErrorCode = "invalid_params" | "forbidden" | "unavailable" | "cancelled";

export class UninstallError extends Error {
  readonly code: UninstallErrorCode;
  constructor(code: UninstallErrorCode, message: string) {
    super(message);
    this.name = "UninstallError";
    this.code = code;
  }
}

const PERSONAL_FOLDERS = [
  "Library",
  "Documents",
  "Desktop",
  "Downloads",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Applications",
];

/** Files that show a folder is a Psyche data folder; one is required before it is moved. */
export const DATA_MARKERS = [join("state", "psyche.sqlite"), "config.json"];

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Why `path` may not be moved to the Trash as the data folder, or null when it may: it must be
 * absolute, resolve strictly inside the home folder (so never the home folder, an ancestor, a
 * volume or the system folders), not be one of the personal folders, and carry a Psyche marker.
 */
export function dataFolderProblem(path: string | undefined, userHome: string): string | null {
  if (path === undefined || path === "") return "no data folder is set";
  if (!isAbsolute(path)) return "it is not an absolute path";
  const p = real(path);
  const h = real(userHome);
  if (p === sep) return "it is the root folder";
  if (p === h) return "it is your home folder";
  if (!p.startsWith(h + sep)) return "it is not inside your home folder";
  for (const d of PERSONAL_FOLDERS) {
    if (p === join(h, d)) return `it is your ${d} folder`;
  }
  if (!DATA_MARKERS.some((m) => existsSync(join(p, m)))) {
    return "it has no Psyche marker (state/psyche.sqlite or config.json)";
  }
  return null;
}

/** `PSYCHE_HOME` from a LaunchAgent plist's `EnvironmentVariables`, XML-unescaped. */
export function psycheHomeFromPlist(plist: string): string | undefined {
  const raw = /<key>PSYCHE_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  const v = raw
    ?.replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  return v === undefined || v === "" ? undefined : v;
}

/** The folders and files the app and the helper keep outside `~/.psyche` (same list as install-local.sh). */
function libraryPaths(userHome: string, agentOurs: boolean): UninstallItem[] {
  const lib = (...p: string[]) => join(userHome, "Library", ...p);
  const item = (kind: UninstallItemKind, path: string, label: string): UninstallItem => ({
    kind,
    path,
    label,
  });
  return [
    ...(agentOurs
      ? [item("agent", lib("LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`), "Gateway LaunchAgent")]
      : []),
    item("support", lib("Application Support", "Psyche"), "Application Support"),
    item("support", lib("Application Support", "com.psyche.helper"), "Helper Application Support"),
    item("cache", lib("Caches", "com.psyche.desktop"), "Caches"),
    item("cache", lib("Caches", "com.psyche.desktop.ShipIt"), "Update cache"),
    item("cache", lib("Caches", "com.psyche.helper"), "Helper caches"),
    item("cache", lib("Caches", "Psyche"), "Caches"),
    item("cache", lib("Logs", "Psyche"), "Logs"),
    item("cache", lib("HTTPStorages", "com.psyche.desktop"), "Web storage"),
    item("cache", lib("HTTPStorages", "com.psyche.desktop.binarycookies"), "Web storage"),
    item("cache", lib("WebKit", "com.psyche.desktop"), "Web storage"),
    item("cache", lib("Preferences", "com.psyche.desktop.plist"), "Preferences"),
    item("cache", lib("Preferences", "com.psyche.helper.plist"), "Preferences"),
    item("state", lib("Saved Application State", "com.psyche.desktop.savedState"), "Saved state"),
    item("state", lib("Saved Application State", "com.psyche.helper.savedState"), "Saved state"),
  ];
}

/** Why `path` cannot be moved to the Trash right now, or null. */
export function trashProblem(path: string): string | null {
  const r = real(path);
  if (r.includes("/AppTranslocation/")) {
    return "the app is running from a temporary read-only copy; move Psyche.app to Applications, open it from there and try again";
  }
  if (r.startsWith("/Volumes/")) {
    return "it is on another volume, where the Trash may not be reachable; move it to the Trash from Finder";
  }
  try {
    accessSync(dirname(r), constants.W_OK);
  } catch {
    return "its folder is read-only or not yours to change; remove it from Finder";
  }
  return null;
}

function dataFolderOf(deps: UninstallDeps): { folder: string | undefined; warnings: string[] } {
  const warnings: string[] = [];
  const env = deps.psycheHome === "" ? undefined : deps.psycheHome;
  const agent = deps.agentPsycheHome === "" ? undefined : deps.agentPsycheHome;
  if (agent !== undefined) {
    if (env !== undefined && real(env) !== real(agent)) {
      warnings.push(
        `PSYCHE_HOME (${env}) differs from the folder the Gateway agent uses (${agent}); using the agent's`,
      );
    }
    return { folder: agent, warnings };
  }
  return { folder: env ?? join(deps.userHome, ".psyche"), warnings };
}

export interface PlanOptions {
  deleteData: boolean;
  removeKeychain?: boolean;
}

/** What uninstalling would do, from what exists right now. Pure: nothing is changed. */
export function planUninstall(deps: UninstallDeps, opts: PlanOptions): UninstallPlan {
  const exists = deps.exists ?? existsSync;
  const agent = deps.agentOwner();
  const warnings: string[] = [];
  const stops: UninstallItem[] = [
    { kind: "helper", path: "", label: "Stop Psyche Helper and turn off open at login" },
  ];
  if (agent === "ours") {
    stops.unshift({
      kind: "agent",
      path: "",
      label: `Stop and unregister ${LAUNCH_AGENT_LABEL}`,
    });
  } else if (agent === "other") {
    warnings.push(
      `The ${LAUNCH_AGENT_LABEL} agent belongs to another copy of Psyche or to the command-line tool; it is left alone`,
    );
  }
  const trash = libraryPaths(deps.userHome, agent === "ours").filter((i) => exists(i.path));
  const blockers: { path: string; reason: string }[] = [];
  let dataFolder: string | undefined;
  if (opts.deleteData) {
    const { folder, warnings: w } = dataFolderOf(deps);
    warnings.push(...w);
    const problem = dataFolderProblem(folder, deps.userHome);
    if (problem !== null) {
      throw new UninstallError(
        "forbidden",
        `Psyche will not move ${folder ?? "the data folder"} to the Trash: ${problem}. Move your data folder to the Trash from Finder if you want it gone.`,
      );
    }
    dataFolder = real(folder as string);
    if (exists(dataFolder)) trash.push({ kind: "data", path: dataFolder, label: "Psyche data" });
  }
  if (deps.appBundlePath !== null && exists(deps.appBundlePath)) {
    if (basename(deps.appBundlePath) !== "Psyche.app") {
      throw new UninstallError(
        "forbidden",
        `This copy is named ${basename(deps.appBundlePath)}, not Psyche.app, so Psyche will not move it. Drag it to the Trash from Finder.`,
      );
    }
    trash.push({ kind: "app", path: deps.appBundlePath, label: "Psyche.app" });
  }
  for (const item of trash) {
    const reason = trashProblem(item.path);
    if (reason !== null) blockers.push({ path: item.path, reason });
  }
  return {
    stops,
    trash,
    deleteData: opts.deleteData,
    ...(dataFolder === undefined ? {} : { dataFolder }),
    agent,
    keychain: opts.deleteData && opts.removeKeychain === true ? [...KEYCHAIN_SERVICES] : [],
    warnings,
    blockers,
  };
}

export interface UninstallRequest extends PlanOptions {
  /** The typed word; required (and checked here) when `deleteData`. */
  confirm?: string;
  /** The approved card from a first `approval_required` answer. */
  approvalId?: string;
}

export interface UninstallResult {
  trashed: string[];
  failed: { path: string; reason: string }[];
  restarted: boolean;
}

const MANUAL =
  "Finish by hand: drag the listed items to the Trash in Finder, then drag Psyche.app to the Trash.";

/**
 * Runs the uninstall. Everything that can refuse does so before anything is stopped: the typed
 * word, the data-folder rules, the pre-flight of every target, the Gateway's presence gate and
 * the native confirmation.
 */
export async function runUninstall(
  deps: UninstallDeps,
  req: UninstallRequest,
): Promise<UninstallResult> {
  const log = deps.log ?? (() => undefined);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (req.deleteData && req.confirm !== DELETE_CONFIRM_WORD) {
    throw new UninstallError("invalid_params", `Type ${DELETE_CONFIRM_WORD} to delete your data`);
  }
  const plan = planUninstall(deps, req);
  if (plan.blockers.length > 0) {
    throw new UninstallError(
      "unavailable",
      `Nothing was changed. These cannot be moved to the Trash from here: ${plan.blockers
        .map((b) => `${b.path} (${b.reason})`)
        .join("; ")}. ${MANUAL}`,
    );
  }
  if (req.deleteData && plan.dataFolder !== undefined) {
    await deps.authorizeDelete(plan.dataFolder, req.approvalId);
  }
  if (!(await deps.confirm(plan))) throw new UninstallError("cancelled", "Uninstall cancelled");

  // 1. Stop what could put things back: the updater (ShipIt reinstalls the app at quit), the
  //    staged update, open at login, the helper, then the Gateway agent.
  const staged = await deps.clearStagedUpdate().catch(() => [] as string[]);
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
  for (const path of staged) await trash(path);

  deps.setOpenAtLogin(false);
  if (deps.helperAppPath !== null) {
    await deps.run("/usr/bin/pkill", ["-f", deps.helperAppPath]).catch(() => undefined);
  }
  let stoppedAgent = false;
  if (plan.agent === "ours") {
    const out = await deps.run("/bin/launchctl", [...launchctl.bootout(deps.uid)]);
    // Gone already (not loaded) is fine; anything else must really have stopped.
    let loaded = await deps.agentLoaded();
    for (let i = 0; loaded && i < 20; i++) {
      await sleep(500);
      loaded = await deps.agentLoaded();
    }
    if (loaded) {
      const restarted = await deps.restartAgent().then(
        () => true,
        () => false,
      );
      throw new UninstallError(
        "unavailable",
        `The Gateway agent would not stop (launchctl exit ${out.code}), so nothing was moved. ${restarted ? "It is still running." : "Restart Psyche to start it again."}`,
      );
    }
    stoppedAgent = true;
  }

  // 2. Move to the Trash. The data folder needs the agent gone (checked above); Saved State
  //    waits until the windows are closed; the app goes last.
  const byKind = (k: UninstallItemKind) => plan.trash.filter((i) => i.kind === k);
  let dataTrashed = false;
  for (const item of plan.trash.filter((i) => i.kind !== "state" && i.kind !== "app")) {
    const ok = await trash(item.path);
    if (item.kind === "data" && ok) dataTrashed = true;
  }
  // cfprefsd caches preference domains; forget them so a trashed plist does not come back.
  for (const domain of ["com.psyche.desktop", "com.psyche.helper"]) {
    await deps.run("/usr/bin/defaults", ["delete", domain]).catch(() => undefined);
  }
  if (dataTrashed && req.removeKeychain === true) {
    for (const svc of plan.keychain) {
      for (let n = 0; n < 50; n++) {
        const r = await deps.run("/usr/bin/security", ["delete-generic-password", "-s", svc]);
        if (r.code !== 0) break;
      }
    }
  }
  if (failed.length > 0) {
    // Something is left half-done: keep the app open so the owner can see it, and bring the
    // Gateway back unless its data is already in the Trash.
    let restarted = false;
    if (stoppedAgent && !dataTrashed) {
      restarted = await deps.restartAgent().then(
        () => true,
        () => false,
      );
    }
    return { trashed, failed, restarted };
  }
  deps.closeWindows();
  for (const item of byKind("state")) await trash(item.path);
  for (const item of byKind("app")) {
    if (!(await trash(item.path))) {
      return { trashed, failed, restarted: false };
    }
  }
  // 3. Quit only when every step worked. macOS lets the moved app keep running until now.
  if (failed.length === 0) deps.quit();
  return { trashed, failed, restarted: false };
}

export { MANUAL as UNINSTALL_MANUAL_STEPS };
