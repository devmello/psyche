import { SPLASH_LEAVE_MS, StartupSplashView, t } from "@psyche/ui";
import { type ReactElement, useEffect, useState } from "react";
import { type GatewayStatus, INITIAL_STATUS } from "../../client/status.ts";
import type { GatewayRunView, MacHelperState, ShellPlatform } from "../platform.ts";

/**
 * The startup splash (#539, #595): the main window's first content while Psyche starts, then it
 * gives way in place to the app once this window is paired (the kit's `StartupSplashView` draws
 * it: the mark, the lantern, the hand-off into the toolbar avatar). No second window. Main decides at launch
 * whether there is anything to wait for (`chrome.splash`): not in dev with PSYCHE_NO_SPLASH=1,
 * not when Psyche already answered (attach mode).
 */

export type SplashLine =
  | { tone: "progress"; text: string }
  | { tone: "ready"; text: string }
  | { tone: "error"; text: string; reason: string };

/** The one status line for what the supervisor, the connection and the helper are doing. */
export function splashLine(i: {
  status: GatewayStatus;
  run: GatewayRunView | undefined;
  helper: MacHelperState["kind"] | undefined;
}): SplashLine {
  if (i.status.phase === "paired") return { tone: "ready", text: t("web.splash.ready") };
  const run = i.run;
  if (run?.kind === "stopped" && run.reason && run.reason !== "quit")
    return { tone: "error", text: t("web.splash.failed"), reason: run.reason };
  if (run?.kind === "starting" && run.step === "installing")
    return { tone: "progress", text: t("web.splash.installing") };
  if (i.status.health === "ok")
    return {
      tone: "progress",
      text: i.helper === "starting" ? t("web.splash.helper") : t("web.splash.connecting"),
    };
  if (run?.kind === "running" || (run?.kind === "starting" && run.step === "waiting"))
    return { tone: "progress", text: t("web.splash.waiting") };
  return { tone: "progress", text: t("web.splash.starting") };
}

/** After this long without pairing, offer to open the app behind the splash. */
export const SPLASH_ESCAPE_MS = 8_000;

export function StartupSplash({
  platform,
  status,
  run,
  helper,
  now = () => Date.now(),
}: {
  platform: ShellPlatform;
  status: GatewayStatus;
  run: GatewayRunView | undefined;
  helper: MacHelperState["kind"] | undefined;
  now?: () => number;
}): ReactElement | null {
  const [up, setUp] = useState(platform.chrome?.splash === true);
  const [leaving, setLeaving] = useState(false);
  const [canSkip, setCanSkip] = useState(false);
  const line = splashLine({ status, run, helper });

  // Paired: give way to the app.
  useEffect(() => {
    if (!up || line.tone !== "ready") return;
    const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    setLeaving(true);
    const timer = setTimeout(() => setUp(false), reduce ? 0 : SPLASH_LEAVE_MS);
    return () => clearTimeout(timer);
  }, [up, line.tone]);

  // A slow start never traps the owner: after a few seconds the app is one click away.
  useEffect(() => {
    if (!up) return;
    const started = now();
    const timer = setTimeout(
      () => setCanSkip(true),
      Math.max(0, SPLASH_ESCAPE_MS - (now() - started)),
    );
    return () => clearTimeout(timer);
  }, [up, now]);

  if (!up) return null;
  const gateway = platform.gateway;
  return (
    <StartupSplashView
      line={line}
      leaving={leaving}
      {...(line.tone === "error" && gateway.showLogs
        ? { onShowLogs: () => void gateway.showLogs?.() }
        : {})}
      {...(line.tone === "error" && gateway.retry ? { onRetry: () => void gateway.retry?.() } : {})}
      {...(canSkip || line.tone === "error" ? { onOpenAnyway: () => setUp(false) } : {})}
    />
  );
}

/** Status, supervisor run and helper state straight from the platform, for the splash. */
function useStartupState(platform: ShellPlatform) {
  const [status, setStatus] = useState<GatewayStatus>(INITIAL_STATUS);
  const [run, setRun] = useState<GatewayRunView>();
  const [helper, setHelper] = useState<MacHelperState["kind"]>();
  useEffect(() => {
    if (platform.chrome?.splash !== true) return;
    let live = true;
    const offs: (() => void)[] = [];
    void platform.gateway.getStatus().then(
      (s) => live && setStatus(s),
      () => undefined,
    );
    offs.push(platform.gateway.onStatus(setStatus));
    const { getRun, onRun } = platform.gateway;
    if (getRun && onRun) {
      void getRun.call(platform.gateway).then(
        (r) => live && setRun(r),
        () => undefined,
      );
      offs.push(onRun.call(platform.gateway, setRun));
    }
    if (platform.helper) {
      void platform.helper.getState().then(
        (h) => live && setHelper(h.kind),
        () => undefined,
      );
      offs.push(platform.helper.onState((h) => setHelper(h.kind)));
    }
    return () => {
      live = false;
      for (const off of offs) off();
    };
  }, [platform]);
  return { status, run, helper };
}

/** The splash wired to the platform: mount once at the top of the app. */
export function ConnectedStartupSplash({
  platform,
}: {
  platform: ShellPlatform;
}): ReactElement | null {
  const state = useStartupState(platform);
  return <StartupSplash platform={platform} {...state} />;
}
