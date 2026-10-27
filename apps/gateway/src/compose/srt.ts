import { getSetting } from "@psyche/db";
import {
  resolveSrt,
  SRT_ENV,
  SRT_SETTING,
  type SrtDeps,
  type SrtStatus,
  systemSrtDeps,
} from "@psyche/sandbox";
import type { ComposeServices } from "./services.ts";

/**
 * The one place the Gateway finds `srt` (Seatbelt; security §5.3): stdio MCP servers, and any
 * part that runs host commands under it, share it. Looked up on every call, so `srt` installed
 * or chosen in Settings (`exec.srtPath`) while the Gateway runs is used without a restart.
 */
export interface SrtResolver {
  resolve(): Promise<{ path: string } | { missing: true; reason: string }>;
  /** The full answer, for `sandbox.status` / `sandbox.setup`. */
  inspect(): Promise<SrtStatus>;
}

export function createSrtResolver(
  services: Pick<ComposeServices, "db">,
  env: NodeJS.ProcessEnv,
  deps: SrtDeps = systemSrtDeps(),
): SrtResolver {
  const inspect = () =>
    resolveSrt(deps, {
      env: env[SRT_ENV],
      setting: getSetting(services.db, SRT_SETTING)?.value,
    });
  return {
    inspect,
    async resolve() {
      const s = await inspect();
      return s.available && s.path !== null
        ? { path: s.path }
        : { missing: true, reason: s.problem ?? "not_found" };
    },
  };
}
