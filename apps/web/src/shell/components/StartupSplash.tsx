import { PROTOCOL_VERSION } from "@psyche/protocol";
import {
  AddGatewayForm,
  documentPrefersReducedMotion,
  GatewaysList,
  groupFingerprint,
  SPLASH_LEAVE_MS,
  SPLASH_LEAVE_REDUCED_MS,
  type SplashActionView,
  StartupSplashView,
  t,
  UiSlotsProvider,
} from "@psyche/ui";
import { type ReactElement, useEffect, useState } from "react";
import { type GatewayStatus, INITIAL_STATUS } from "../../client/status.ts";
import type {
  GatewayRunView,
  MacHelperState,
  SavedGatewayView,
  ShellPlatform,
} from "../platform.ts";

/**
 * The startup splash (#539, #595): the main window's first content while Psyche starts, then it
 * gives way in place to the app once this window is paired (the kit's `StartupSplashView` draws
 * it: the moth, the wake-up steps, the hand-off into the toolbar avatar). No second window. Main decides at launch
 * whether there is anything to wait for (`chrome.splash`): not in dev with PSYCHE_NO_SPLASH=1,
 * not when Psyche already answered (attach mode).
 */

/** What the owner can do from a remote Gateway's start (remote-gateway design §4.6). */
export type SplashActionId = "retry" | "switch" | "useThisMac" | "pairAgain" | "forget";

export type SplashLine =
  | { tone: "progress"; text: string; step: 0 | 1 | 2; detail?: string[] }
  | { tone: "ready"; text: string }
  | {
      tone: "error";
      text: string;
      reason: string;
      actions?: SplashActionId[];
      /** Retrying cannot help and the app behind must not open: the Gateway failed a check. */
      fatal?: true;
    };

const IDENTITY_REASON: Record<string, string> = {
  gateway_identity_changed: "web.splash.remote.identityChanged",
  gateway_identity_missing: "web.splash.remote.identityMissing",
  gateway_identity_invalid: "web.splash.remote.identityInvalid",
  gateway_origin_mismatch: "web.splash.remote.identityOrigin",
  gateway_cert_changed: "web.splash.remote.certChanged",
  gateway_cert_missing: "web.splash.remote.certMissing",
  gateway_cert_invalid: "web.splash.remote.certInvalid",
};

/**
 * The line for a Gateway on another computer: finding it, checking it is the one that was paired,
 * waiting for approval, and the failures that each get one cause and their own actions (design
 * §4.6). `waited` is true once ten seconds have passed without an answer.
 */
function remoteSplashLine(
  status: GatewayStatus,
  host: string,
  waited: boolean,
  hostHasLocal: boolean,
  lan = false,
): SplashLine {
  if (status.phase === "paired") return { tone: "ready", text: t("web.splash.ready") };
  const code = status.lastError;
  if (status.phase === "error" && code === "gateway_pins_unreadable") {
    return {
      tone: "error",
      text: t("web.splash.remote.pinsUnreadable"),
      reason: t("web.splash.remote.pinsUnreadableReason"),
      actions: ["switch"],
      fatal: true,
    };
  }
  if (status.phase === "error" && code !== undefined && code in IDENTITY_REASON) {
    return {
      tone: "error",
      text: t("web.splash.remote.identity", { host }),
      reason: t(IDENTITY_REASON[code] as "web.splash.remote.identityChanged", { host }),
      actions: ["switch", "pairAgain"],
      fatal: true,
    };
  }
  if (status.phase === "error" && code === "protocol_version_mismatch") {
    const hostOlder =
      status.serverProtocolVersion !== undefined && status.serverProtocolVersion < PROTOCOL_VERSION;
    return {
      tone: "error",
      text: hostOlder
        ? t("web.splash.remote.olderHost", { host })
        : t("web.splash.remote.olderApp", { host }),
      reason: hostOlder
        ? t("web.splash.remote.olderHostReason", { host })
        : t("web.splash.remote.olderAppReason"),
      actions: ["retry", "switch"],
    };
  }
  if (status.phase === "denied" && status.deniedCode === "setup_token_invalid") {
    return {
      tone: "error",
      text: t("web.splash.remote.tokenRefused", { host }),
      reason: t("web.splash.remote.tokenRefusedReason", { host }),
      actions: ["switch", "forget"],
      fatal: true,
    };
  }
  if (status.phase === "denied" && code === "device revoked") {
    return {
      tone: "error",
      text: t("web.splash.remote.revoked", { host }),
      reason: t("web.splash.remote.revokedReason"),
      actions: ["pairAgain", "forget"],
      fatal: true,
    };
  }
  if (status.phase === "pending") {
    return {
      tone: "progress",
      text: t("web.splash.remote.waiting", { host }),
      step: 2,
      detail: [
        ...(status.pairingCode
          ? [t("web.splash.remote.pairCode", { code: status.pairingCode })]
          : []),
        ...(status.gatewayFingerprint
          ? [
              // On the network the whole fingerprint is shown: it is the only proof of who
              // answered, so it is compared in full (the Host's pairing card shows it too).
              t("web.splash.remote.pairKey", {
                fingerprint: lan
                  ? (status.gatewayFingerprint
                      .replace(/^sha256:/, "")
                      .match(/.{1,4}/g)
                      ?.join(" ") ?? status.gatewayFingerprint)
                  : groupFingerprint(status.gatewayFingerprint),
              }),
            ]
          : []),
        t(lan ? "web.splash.remote.pairHintLan" : "web.splash.remote.pairHint", { host }),
      ],
    };
  }
  if (waited && (status.health === "unreachable" || status.attempt > 0)) {
    return {
      tone: "error",
      text: t("web.splash.remote.unreachable", { host }),
      reason: t("web.splash.remote.unreachableReason"),
      actions: hostHasLocal ? ["retry", "switch", "useThisMac"] : ["retry", "switch"],
    };
  }
  if (status.health === "ok" || status.phase === "challenge" || status.phase === "verifying") {
    return { tone: "progress", text: t("web.splash.remote.checking", { host }), step: 1 };
  }
  return { tone: "progress", text: t("web.splash.remote.finding", { host }), step: 0 };
}

/** The one status line for what the supervisor, the connection and the helper are doing. */
export function splashLine(i: {
  status: GatewayStatus;
  run: GatewayRunView | undefined;
  helper: MacHelperState["kind"] | undefined;
  /** The window is a client of this Host: the line is about reaching it, not starting one. */
  remote?: { hostName: string; waited?: boolean; hasLocal?: boolean; lan?: boolean };
}): SplashLine {
  if (i.remote) {
    return remoteSplashLine(
      i.status,
      i.remote.hostName,
      i.remote.waited === true,
      i.remote.hasLocal === true,
      i.remote.lan === true,
    );
  }
  if (i.status.phase === "paired") return { tone: "ready", text: t("web.splash.ready") };
  const run = i.run;
  if (run?.kind === "stopped" && run.reason && run.reason !== "quit")
    return { tone: "error", text: t("web.splash.failed"), reason: run.reason };
  if (run?.kind === "starting" && run.step === "installing")
    return { tone: "progress", text: t("web.splash.installing"), step: 0 };
  if (i.status.health === "ok")
    return {
      tone: "progress",
      text: i.helper === "starting" ? t("web.splash.helper") : t("web.splash.connecting"),
      step: 2,
    };
  if (run?.kind === "running" || (run?.kind === "starting" && run.step === "waiting"))
    return { tone: "progress", text: t("web.splash.waiting"), step: 1 };
  return { tone: "progress", text: t("web.splash.starting"), step: 0 };
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
  const host = platform.chrome?.remote?.hostName;
  const [waited, setWaited] = useState(false);
  const [saved, setSaved] = useState<SavedGatewayView[]>([]);
  const [picking, setPicking] = useState(false);
  // Ten seconds without an answer is "isn't answering", not a spinner (design §4.6).
  useEffect(() => {
    if (host === undefined) return;
    const timer = setTimeout(() => setWaited(true), 10_000);
    return () => clearTimeout(timer);
  }, [host]);
  useEffect(() => {
    if (host === undefined || !platform.gateways) return;
    let live = true;
    void platform.gateways.list().then(
      (l) => live && setSaved(l),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [host, platform.gateways]);
  const line = splashLine({
    status,
    run,
    helper,
    ...(host === undefined
      ? {}
      : {
          remote: {
            hostName: host,
            waited,
            hasLocal: saved.some((g) => !g.remote),
            lan: saved.some((g) => g.active && g.lan === true),
          },
        }),
  });

  // A Gateway that fails its identity check, or removes this computer, while the app is open
  // brings the full-window state back: nothing about that is a banner (design §4.6).
  const fatalRemote = host !== undefined && line.tone === "error" && line.fatal === true;
  useEffect(() => {
    if (!fatalRemote) return;
    setLeaving(false);
    setUp(true);
  }, [fatalRemote]);

  // Paired: give way to the app.
  useEffect(() => {
    if (!up || line.tone !== "ready") return;
    const reduce = documentPrefersReducedMotion();
    setLeaving(true);
    // Reduced motion still crosses over: one opacity fade, not a hard cut.
    const timer = setTimeout(
      () => setUp(false),
      reduce ? SPLASH_LEAVE_REDUCED_MS : SPLASH_LEAVE_MS,
    );
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
  const gateways = platform.gateways;
  const remoteLine = host !== undefined && line.tone === "error" ? line : undefined;
  const active = saved.find((g) => g.active);
  const run1 = (p: Promise<unknown> | undefined) => void p?.catch(() => undefined);
  const actionViews: SplashActionView[] = [];
  if (remoteLine?.actions && gateways) {
    for (const id of remoteLine.actions) {
      if (id === "retry") {
        if (gateway.retry)
          actionViews.push({
            id,
            text: t("common.tryAgain"),
            primary: true,
            onClick: () => run1(gateway.retry?.()),
          });
      } else if (id === "switch") {
        actionViews.push({
          id,
          text: t("web.splash.remote.switch"),
          onClick: () => setPicking((v) => !v),
        });
      } else if (id === "useThisMac") {
        const mac = saved.find((g) => !g.remote);
        if (mac)
          actionViews.push({
            id,
            text: t("web.splash.remote.useThisMac"),
            onClick: () => run1(gateways.switchTo(mac.id)),
          });
      } else if (id === "pairAgain" && active) {
        actionViews.push({
          id,
          text: t("web.splash.remote.pairAgain"),
          primary: true,
          onClick: () => run1(gateways.repair(active.id)),
        });
      } else if (id === "forget" && active) {
        actionViews.push({
          id,
          text: t("web.splash.remote.forget", { host: active.name }),
          onClick: () => run1(gateways.remove(active.id)),
        });
      }
    }
  }
  if (
    host === undefined &&
    run?.kind === "stopped" &&
    run.restoreInterrupted === true &&
    gateway.restoredByHand !== undefined
  ) {
    actionViews.push({
      id: "restoredByHand",
      text: t("web.splash.restoredByHand"),
      onClick: () => run1(gateway.restoredByHand?.()),
    });
  }
  const reload = () => {
    void gateways?.list().then(setSaved, () => undefined);
  };
  const openAnyway =
    host !== undefined
      ? remoteLine?.fatal !== true && (canSkip || line.tone === "error")
      : canSkip || line.tone === "error";
  return (
    <StartupSplashView
      line={line}
      leaving={leaving}
      slow={canSkip && line.tone === "progress"}
      {...(line.tone === "error" && gateway.showLogs && host === undefined
        ? { onShowLogs: () => void gateway.showLogs?.() }
        : {})}
      {...(line.tone === "error" && gateway.retry && host === undefined
        ? { onRetry: () => void gateway.retry?.() }
        : {})}
      {...(openAnyway ? { onOpenAnyway: () => setUp(false) } : {})}
      {...(actionViews.length > 0 ? { actions: actionViews } : {})}
      {...(picking && gateways
        ? {
            below: (
              <UiSlotsProvider value={{ gateways }}>
                <div className="flex w-full max-w-lg flex-col gap-3 text-start">
                  <GatewaysList entries={saved} onChanged={reload} onError={() => undefined} />
                  <AddGatewayForm onAdded={reload} />
                </div>
              </UiSlotsProvider>
            ),
          }
        : {})}
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
