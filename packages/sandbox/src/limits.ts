import { EXEC_DEFAULT_TIMEOUT_MS, EXEC_OUTPUT_CAP_BYTES } from "@psyche/protocol";

export { EXEC_DEFAULT_TIMEOUT_MS, EXEC_OUTPUT_CAP_BYTES };

/** Per-container resource caps (architecture §9, security §5.1). */
export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  pids: number;
  tmpMb: number;
}

export const DEFAULT_LIMITS: Readonly<SandboxLimits> = Object.freeze({
  memoryMb: 512,
  cpus: 1,
  pids: 128,
  tmpMb: 64,
});

/** UID/GID every command runs as. The image's `psyche` user. */
export const SANDBOX_UID = 1000;
export const SANDBOX_GID = 1000;
export const WORKSPACE_PATH = "/workspace";

/** Grace between SIGTERM and SIGKILL for a timed-out or interrupted command. */
export const KILL_GRACE_MS = 2_000;
/** Extra host-side slack before the watchdog gives up on the container CLI itself. */
export const HOST_WATCHDOG_SLACK_MS = 5_000;
/** Upper bound for a caller-supplied timeout ("up to the automation budget"). */
export const DEFAULT_MAX_TIMEOUT_MS = 30 * 60_000;

export const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAX_CONCURRENT_EXECS = 4;
export const DEFAULT_MAX_PTYS = 4;
/** Apple `container` VMs keep ~240 MB each and do not return freed memory (spike 02). */
export const DEFAULT_MAX_RUNNING_APPLE = 3;
export const DEFAULT_MAX_RUNNING_SANDBOXES = 8;

/** `filesChanged` lists at most this many paths. */
export const FILES_CHANGED_CAP = 1_000;

/** File API caps (OpenMuse's: text 256 KB, import/export 10 MB). */
export const TEXT_FILE_CAP_BYTES = 256 * 1024;
export const TRANSFER_FILE_CAP_BYTES = 10 * 1024 * 1024;
export const LIST_ENTRIES_CAP = 10_000;

/** Bytes of PTY output kept for the receipt (security §5.4). */
export const PTY_TRANSCRIPT_BYTES = 128 * 1024;

/** Apple `container` volumes are fixed-size ext4 images. */
export const DEFAULT_APPLE_VOLUME_SIZE = "8G";
