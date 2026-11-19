import { lstat, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { sameHostPath } from "@psyche/hostfs";
import { PsycheError } from "@psyche/protocol";
import { isUnder } from "./workspace.ts";

/**
 * Real-path containment for the `code.*` tools. `resolveInRoot` only confines a path textually,
 * and the broker judges that textual path, so a link committed in the repository (`up -> ..`,
 * `keys -> ~/.ssh`, as `git clone` creates them) would otherwise take a read, a walk or a write
 * outside the workspace with no approval. Every path a tool hands to the file system goes
 * through here first:
 *
 * - the root must still be its own real path (the folder `code.open` checked);
 * - no component between the root and the target may be a link, even one that points back inside
 *   the repository: like `read_file`, `write_file` and `code.open`, a path is used by its real
 *   name ("use the real path"), and a walk skips links instead of following them;
 * - the target itself may be a link only when the caller passes `finalLink: "allow"` (git stages
 *   a link as a link and never follows it);
 * - parts of the path that do not exist yet are fine: there is nothing to follow.
 *
 * Node has no `openat` or `fdopendir`, so a concurrent writer in the repository (a `code.run`
 * the owner approved) could still swap a folder for a link between this check and the use and
 * back again; the walk re-checks each folder after reading it to narrow that window.
 */
export async function assertContained(
  root: string,
  full: string,
  opts: { finalLink?: "refuse" | "allow" } = {},
): Promise<void> {
  const realRoot = await realpath(root).catch(() => undefined);
  if (realRoot === undefined || !sameHostPath(realRoot, root)) {
    throw new PsycheError(
      "forbidden",
      `${root} is no longer the folder that was opened; open it again`,
    );
  }
  if (!isUnder(full, root)) throw new PsycheError("forbidden", `${full} is outside ${root}`);
  const viaLink = () =>
    new PsycheError("forbidden", `${full} goes through a symlink; use the real path`, {
      details: { reason: "symlink_escape" },
    });
  if (opts.finalLink !== "allow" && !sameHostPath(full, root)) {
    const st = await lstat(full).catch(missing);
    if (st?.isSymbolicLink() === true) throw viaLink();
  }
  // The deepest folder that exists must be its own real path, inside the real root.
  for (let d = sameHostPath(full, root) ? root : dirname(full); ; d = dirname(d)) {
    const real = await realpath(d).catch(missing);
    if (real !== undefined) {
      if (!sameHostPath(real, d) || !isUnder(real, realRoot)) throw viaLink();
      return;
    }
    // `d` is under the root, and the root exists: the loop ends there at the latest.
    if (sameHostPath(d, root) || dirname(d) === d) throw viaLink();
  }
}

/** `ENOENT` / `ENOTDIR` mean "not there": nothing to follow. Anything else stays an error. */
function missing(err: unknown): undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return undefined;
  throw err;
}
