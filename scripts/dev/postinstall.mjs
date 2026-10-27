// Root postinstall: share Electron's dist across worktrees (scripts/dev/electron-dist.sh).
// Best effort and offline: it never downloads and it never fails an install.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const script = join(dirname(fileURLToPath(import.meta.url)), "electron-dist.sh");
  spawnSync("sh", [script], { stdio: "inherit" });
}
