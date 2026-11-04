import type { SupervisorMode } from "./supervisor.ts";

/**
 * The startup splash (#539) is the main window's first content, drawn by the web shell
 * (`apps/web/src/shell/components/StartupSplash.tsx`); main only decides at launch whether there
 * is anything to wait for and passes it in the main window's chrome launch argument.
 */

/** Whether to show the splash at all. */
export function shouldShowSplash(o: {
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  mode: SupervisorMode;
  /** The Gateway already answered at launch (attach mode): nothing to wait for. */
  healthyAtLaunch: boolean;
  /** The first-paint perf probe runs without extra windows. */
  probing?: boolean;
}): boolean {
  if (o.probing) return false;
  if (!o.packaged && o.env.PSYCHE_NO_SPLASH === "1") return false;
  if (o.mode === "external") return false;
  // A remote Gateway is never "already up" in the sense that matters: the splash is where an
  // unreachable Host, a changed identity or a version mismatch is explained (design §4.6).
  if (o.mode === "remote") return true;
  return !o.healthyAtLaunch;
}
