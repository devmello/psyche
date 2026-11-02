import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `sun_path` holds 104 bytes on macOS and 108 on Linux, including the terminating NUL. */
export const MAX_BRIDGE_SOCKET_BYTES = process.platform === "darwin" ? 103 : 107;

/** The file the Gateway writes under `$PSYCHE_HOME/run` when the bridge socket is not the default. */
export const BRIDGE_SOCKET_POINTER = "browser-bridge-socket";

/**
 * Where the browser bridge listens when `PSYCHE_BROWSER_BRIDGE_SOCKET` is unset:
 * `$PSYCHE_HOME/run/browser-bridge.sock`, or, when `$PSYCHE_HOME` is too deep for a Unix socket,
 * `<tmp>/psyche-<uid>/b-<hash>.sock` (the directory is made private, 0700, by the server). The
 * desktop finds a fallback through the pointer file the Gateway writes, so both ends agree.
 */
export function defaultBridgeSocketPath(home: string): string {
  const preferred = join(home, "run", "browser-bridge.sock");
  if (Buffer.byteLength(preferred) <= MAX_BRIDGE_SOCKET_BYTES) return preferred;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const hash = createHash("sha256").update(home).digest("hex").slice(0, 16);
  for (const base of [tmpdir(), "/tmp"]) {
    const fallback = join(base, `psyche-${uid}`, `b-${hash}.sock`);
    if (Buffer.byteLength(fallback) <= MAX_BRIDGE_SOCKET_BYTES) return fallback;
  }
  return preferred;
}
