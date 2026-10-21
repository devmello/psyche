import { t } from "@psyche/ui";
import { type ReactElement, useEffect, useState } from "react";
import { type GatewayStatus, INITIAL_STATUS } from "../../client/status.ts";
import type { GatewayRunView, MacHelperState, ShellPlatform } from "../platform.ts";

/**
 * The startup splash (#539): the main window's first content while Psyche starts, then it gives
 * way in place to the app once this window is paired. No second window. Main decides at launch
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
/** The splash fades into the app (instantly under reduced motion). */
const FADE_MS = 220;

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
    const timer = setTimeout(() => setUp(false), reduce ? 0 : FADE_MS);
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
  return (
    <div
      className="startup-splash"
      data-tone={line.tone}
      data-leaving={leaving || undefined}
      data-testid="startup-splash"
    >
      <div className="startup-splash-body">
        <svg width="64" height="64" viewBox="0 0 32 32" aria-hidden="true">
          <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <path
            d="M16 6v20M9 11c0 5 3 8 7 8s7-3 7-8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          />
        </svg>
        {/* i18n-ignore: the product name */}
        <h1>Psyche</h1>
        <p role="status" aria-live="polite">
          {line.text}
        </p>
        {line.tone === "progress" ? (
          <div className="startup-splash-bar" aria-hidden="true" />
        ) : null}
        {line.tone === "error" ? (
          <div className="startup-splash-error">
            <p className="startup-splash-reason">{line.reason}</p>
            <div className="startup-splash-actions">
              {platform.gateway.showLogs ? (
                <button
                  type="button"
                  className="startup-splash-button"
                  onClick={() => void platform.gateway.showLogs?.()}
                >
                  {t("web.splash.showLogs")}
                </button>
              ) : null}
              {platform.gateway.retry ? (
                <button
                  type="button"
                  className="startup-splash-button primary"
                  onClick={() => void platform.gateway.retry?.()}
                >
                  {t("web.splash.retry")}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
        {canSkip || line.tone === "error" ? (
          <button type="button" className="startup-splash-button skip" onClick={() => setUp(false)}>
            {t("web.splash.openAnyway")}
          </button>
        ) : null}
      </div>
    </div>
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
