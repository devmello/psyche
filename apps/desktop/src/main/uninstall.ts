import { basename, join, resolve, sep } from "node:path";
import { LAUNCH_AGENT_LABEL, launchctl, type Runner } from "./supervisor.ts";

/**
 * Uninstall Psyche (docs/design/updates-and-install-2026.md section 3.5), driven from Settings →
 * About. Main-process only: the IPC channels are in `REMOTE_REFUSED_CHANNELS`, and "Delete my
 * data" needs the owner's fresh presence (`app.uninstall.authorize` on the Gateway) plus a typed
 * word. Everything is moved to the Trash with Electron's `shell.trashItem`, never `rm -rf`, so
 * the owner can still put a file back. Every outside effect comes in through `UninstallDeps`, so
 * tests run it on temporary paths with fakes.
 */

/** The word the owner types to confirm deleting their data. */
export const DELETE_CONFIRM_WORD = "DELETE";

export type UninstallItemKind = "agent" | "helper" | "support" | "cache" | "app" | "data";

export interface UninstallItem {
  kind: UninstallItemKind;
  /** Absolute path; empty for things that are stopped rather than removed. */
  path: string;
  /** What it is, in plain words (the sheet shows the path and a translated heading). */
  label: string;
}

export interface UninstallPlan {
  /** What is stopped or unregistered (the Gateway agent, the helper, open at login). */
  stops: UninstallItem[];
  /** What is moved to the Trash, in order. Only paths that exist. */
  trash: UninstallItem[];
  deleteData: boolean;
}

export interface UninstallDeps {
  /** The user's home directory (Library lives under it). */
  userHome: string;
  /** `$PSYCHE_HOME`, usually `~/.psyche`. */
  psycheHome: string;
  /** The installed bundle, or null for an unpackaged build (nothing is moved then). */
  appBundlePath: string | null;
  /** The helper app inside the bundle, or null. */
  helperAppPath: string | null;
  uid: number;
  exists: (path: string) => boolean;
  run: Runner;
  /** Electron `shell.trashItem`. */
  trashItem: (path: string) => Promise<void>;
  /** Turns "open at login" off. */
  setOpenAtLogin: (value: boolean) => void;
  /** Asks the Gateway for fresh presence; throws `approval_required` with `details.approvalId`. */
  authorizeDelete: (approvalId: string | undefined) => Promise<void>;
  /** Quits the app (`app.quit`). */
  quit: () => void;
  log?: (message: string) => void;
}

export class UninstallError extends Error {
  readonly code: "invalid_params" | "forbidden";
  constructor(code: "invalid_params" | "forbidden", message: string) {
    super(message);
    this.name = "UninstallError";
    this.code = code;
  }
}

/** What the app, the Gateway agent and the helper keep outside `~/.psyche` (same list as install-local.sh). */
function libraryPaths(userHome: string): UninstallItem[] {
  const lib = (...p: string[]) => join(userHome, "Library", ...p);
  const item = (kind: UninstallItemKind, path: string, label: string): UninstallItem => ({
    kind,
    path,
    label,
  });
  return [
    item("agent", lib("LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`), "Gateway LaunchAgent"),
    item("support", lib("Application Support", "Psyche"), "Application Support"),
    item("support", lib("Application Support", "com.psyche.helper"), "Helper Application Support"),
    item("cache", lib("Caches", "com.psyche.desktop"), "Caches"),
    item("cache", lib("Caches", "com.psyche.helper"), "Helper caches"),
    item("cache", lib("Caches", "Psyche"), "Caches"),
    item("cache", lib("Logs", "Psyche"), "Logs"),
    item("cache", lib("HTTPStorages", "com.psyche.desktop"), "Web storage"),
    item("cache", lib("WebKit", "com.psyche.desktop"), "Web storage"),
    item("cache", lib("Saved Application State", "com.psyche.desktop.savedState"), "Saved state"),
    item("cache", lib("Saved Application State", "com.psyche.helper.savedState"), "Saved state"),
    item("cache", lib("Preferences", "com.psyche.desktop.plist"), "Preferences"),
    item("cache", lib("Preferences", "com.psyche.helper.plist"), "Preferences"),
  ];
}

/** True when `path` is a folder strictly inside the user's home that we may move to the Trash. */
function safeDataFolder(path: string, userHome: string): boolean {
  const p = resolve(path);
  const h = resolve(userHome);
  return p !== sep && p.startsWith(h + sep) && p.length > h.length + 1;
}

/** What uninstalling would do, from what exists right now. Pure: nothing is changed. */
export function planUninstall(deps: UninstallDeps, deleteData: boolean): UninstallPlan {
  const stops: UninstallItem[] = [
    { kind: "agent", path: "", label: `Stop and unregister ${LAUNCH_AGENT_LABEL}` },
    { kind: "helper", path: "", label: "Stop Psyche Helper and turn off open at login" },
  ];
  const trash = libraryPaths(deps.userHome).filter((i) => deps.exists(i.path));
  if (deleteData) {
    if (!safeDataFolder(deps.psycheHome, deps.userHome)) {
      throw new UninstallError(
        "forbidden",
        `Refusing to remove ${deps.psycheHome} as the data folder`,
      );
    }
    if (deps.exists(deps.psycheHome)) {
      trash.push({ kind: "data", path: resolve(deps.psycheHome), label: "Psyche data" });
    }
  }
  if (deps.appBundlePath !== null && deps.exists(deps.appBundlePath)) {
    if (basename(deps.appBundlePath) !== "Psyche.app") {
      throw new UninstallError("forbidden", `Refusing to move ${deps.appBundlePath} to the Trash`);
    }
    trash.push({ kind: "app", path: deps.appBundlePath, label: "Psyche.app" });
  }
  return { stops, trash, deleteData };
}

export interface UninstallRequest {
  deleteData: boolean;
  /** The typed word; required (and checked here) when `deleteData`. */
  confirm?: string;
  /** The approved card from a first `approval_required` answer. */
  approvalId?: string;
}

export interface UninstallResult {
  trashed: string[];
  failed: { path: string; reason: string }[];
}

/**
 * Runs the uninstall. A request that deletes data is checked first (the typed word, then the
 * Gateway's presence gate) before anything is stopped, so a refused or cancelled approval leaves
 * the app exactly as it was.
 */
export async function runUninstall(
  deps: UninstallDeps,
  req: UninstallRequest,
): Promise<UninstallResult> {
  const log = deps.log ?? (() => undefined);
  if (req.deleteData && req.confirm !== DELETE_CONFIRM_WORD) {
    throw new UninstallError("invalid_params", `Type ${DELETE_CONFIRM_WORD} to delete your data`);
  }
  const plan = planUninstall(deps, req.deleteData);
  if (req.deleteData) await deps.authorizeDelete(req.approvalId);

  // 1. Stop what runs from the bundle: open at login, the helper, the Gateway agent.
  deps.setOpenAtLogin(false);
  if (deps.helperAppPath !== null) {
    await deps.run("/usr/bin/pkill", ["-f", deps.helperAppPath]).catch(() => undefined);
  }
  await deps.run("/bin/launchctl", [...launchctl.bootout(deps.uid)]).catch(() => undefined);

  // 2. Move to the Trash, the app last: a failure earlier leaves a working app to retry from.
  const trashed: string[] = [];
  const failed: { path: string; reason: string }[] = [];
  const ordered = [...plan.trash].sort(
    (a, b) => Number(a.kind === "app") - Number(b.kind === "app"),
  );
  for (const item of ordered) {
    try {
      await deps.trashItem(item.path);
      trashed.push(item.path);
      log(`moved to the Trash: ${item.path}`);
    } catch (err) {
      failed.push({ path: item.path, reason: String(err) });
      log(`could not move ${item.path} to the Trash: ${String(err)}`);
    }
  }
  // 3. Quit. macOS lets the moved app keep running until now.
  deps.quit();
  return { trashed, failed };
}
