import { PsycheError } from "@psyche/protocol";
import type { VmRunner } from "./vm.ts";

/**
 * Where srt's features run on Windows (security §5.3, §11). srt has no Windows build, so run_script,
 * save_script_as_tool, Psyche-made connectors and local stdio MCP servers run in the sandbox PC's
 * Linux guest instead (VM mode, `VmRunner.run` / `openStdio`), with the same cards as on a Mac.
 * While it is off they explain how to turn it on; nothing ever falls back to running on the
 * owner's own PC.
 */

/** What the srt features need of the VM runner. */
export type GuestSandbox = Pick<VmRunner, "canIsolate" | "run">;

export const TURN_ON_SANDBOX_PC =
  "Turn on the sandbox PC (Settings → Sandbox PC) to run this on Windows";

/** Whether this host runs srt's features in the sandbox PC (Windows) instead of srt. */
export const usesSandboxPc = (platform: NodeJS.Platform = process.platform) => platform === "win32";

/**
 * The error a srt feature gives on Windows while the sandbox PC cannot run it: the fix is the
 * `sandbox` permission, whose card on Windows is "Turn on the sandbox PC".
 */
export function sandboxPcOff(what: string): PsycheError {
  return new PsycheError("unavailable", `${what}: ${TURN_ON_SANDBOX_PC}`, {
    details: { reason: "sandbox_pc_off", missing: { need: "sandbox" } },
  });
}
