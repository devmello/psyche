import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isNamedPipePath } from "@psyche/protocol/platform";

/**
 * The node endpoint of a Gateway running on this machine, or `undefined`. The Gateway records the
 * endpoint it listens on in `$PSYCHE_HOME/run/node-socket` (a Unix socket path, which moves under
 * the temp dir for a deep home, or on Windows the named pipe `\\.\pipe\psyche-node-<hash>`) and
 * removes the file when it stops; `run/node.sock` is the default when there is no pointer. A pipe
 * has no file to test, so a recorded pipe is taken as is: a stale one only fails to connect, and
 * the next transport is tried.
 */
export function localGatewaySocket(psycheHome: string): string | undefined {
  try {
    const pointed = readFileSync(join(psycheHome, "run", "node-socket"), "utf8").trim();
    if (pointed !== "" && (isNamedPipePath(pointed) || existsSync(pointed))) return pointed;
  } catch {
    // no pointer: an older Gateway, or none running
  }
  const preferred = join(psycheHome, "run", "node.sock");
  return existsSync(preferred) ? preferred : undefined;
}
