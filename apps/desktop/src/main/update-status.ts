import type { UpdaterState } from "./updater.ts";

/**
 * What the owner sees about the app's own update: a quiet "ready" banner and the About row. Main
 * keeps it and tells the windows when it changes (`psyche:update:changed`); the renderer asks for it
 * with `psyche:update:status`. Pure on purpose: the mapping and the restart gate are unit-tested.
 */
export type UpdateStatus =
  | { state: "idle" } // not checked (off, unpackaged, or another OS)
  | { state: "checking" } // a verified download is in flight
  | { state: "none" } // up to date, or no manifest published
  | { state: "ready"; release: string; mandatory: boolean } // installs on restart
  | { state: "refused"; reason: string }; // verification failed; nothing applied

/** The result of one check, as `runUpdater` reports it. */
export interface CheckOutcome {
  state: UpdaterState;
  reason?: string;
  code?: string;
}

/**
 * Maps one check's outcome to the status. `started` on macOS means the verified file is handed to
 * Squirrel: the status is `checking` until `update-downloaded` says it is ready.
 */
export function updateStatusFromOutcome(outcome: CheckOutcome): UpdateStatus {
  switch (outcome.state) {
    case "started":
      return { state: "checking" };
    case "none":
      return { state: "none" };
    case "refused":
      return { state: "refused", reason: outcome.reason ?? outcome.code ?? "unknown" };
    case "disabled":
    case "no_keys":
      return { state: "idle" };
  }
}

let current: UpdateStatus = { state: "idle" };
const listeners = new Set<(s: UpdateStatus) => void>();

export function getUpdateStatus(): UpdateStatus {
  return current;
}

export function setUpdateStatus(next: UpdateStatus): void {
  current = next;
  for (const l of listeners) l(next);
}

/** Subscribes to status changes; returns the unsubscribe function. */
export function onUpdateStatus(listener: (s: UpdateStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Why "Restart to update" must be refused, or undefined when it may quit and install. Only macOS
 * installs through Squirrel here, and only a verified update that is ready may be installed.
 */
export function restartRefusal(platform: string, status: UpdateStatus): string | undefined {
  if (platform !== "darwin") return "Restart to update is only available on macOS";
  if (status.state !== "ready") return "no verified update is ready to install";
  return undefined;
}
