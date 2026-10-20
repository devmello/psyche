import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PYTHON, STATE_DIR } from "../src/scripts.ts";

/**
 * Runs the real `EXEC_WRAPPER` on the host with stand-ins for the Linux-only tools, so the
 * shell plumbing is tested without a container. The `setsid` stand-in is strict like util-linux
 * `setsid --wait`: it forks, then `wait()`s once and fails ("setsid: wait") if the first child
 * to exit is not the one it forked, which is how the #314 regression broke on real containers.
 * Lines that need GNU `date` / `touch` are swapped for an equivalent marker write.
 */
export function runWrapper(
  wrapper: string,
  args: { id: string; mode: "--" | "--env"; argv: string[]; stdin?: Buffer },
): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), "psyche-wrapper-"));
  try {
    const python = spawnSync("sh", ["-c", "command -v python3"]).stdout.toString().trim();
    const setsid = join(dir, "setsid");
    writeFileSync(
      setsid,
      `#!${python}
import os, sys
args = sys.argv[1:]
wait = args[:1] == ["--wait"]
if wait:
    args = args[1:]
pid = os.fork()
if pid == 0:
    os.setsid()
    os.execvp(args[0], args)
if wait:
    got, status = os.wait()
    if got != pid:
        sys.stderr.write("setsid: wait: No such file or directory\\n")
        os._exit(1)
    os._exit(os.waitstatus_to_exitcode(status) & 255)
os._exit(0)
`,
    );
    const timeout = join(dir, "timeout");
    writeFileSync(timeout, '#!/bin/sh\nshift 2\nexec "$@"\n');
    chmodSync(setsid, 0o755);
    chmodSync(timeout, 0o755);
    const state = join(dir, "state");
    const source = rebuild(wrapper)
      .replaceAll("/usr/bin/setsid", setsid)
      .replaceAll("/usr/bin/timeout", timeout)
      .replaceAll("/usr/bin/bash", "/bin/bash")
      .replaceAll("/usr/bin/mkdir", "mkdir")
      .replaceAll(PYTHON, python)
      .replaceAll(STATE_DIR, state);
    const r = spawnSync(
      "/bin/bash",
      ["-c", source, "psyche-exec", args.id, "5", args.mode, ...args.argv],
      {
        input: args.stdin ?? Buffer.alloc(0),
        timeout: 20_000,
      },
    );
    return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replaces the GNU-only marker block (date +%N, touch -d @…) with a plain marker write. */
function rebuild(wrapper: string): string {
  const lines = wrapper.split("\n");
  const start = lines.findIndex((l) => l.startsWith("__ts="));
  const end = lines.findIndex((l, i) => i > start && l === "fi");
  if (start < 0 || end < 0) throw new Error("wrapper layout changed: update the harness");
  lines.splice(start, end - start + 1, ': > "$__d/$__id.mark"');
  return lines.join("\n");
}
