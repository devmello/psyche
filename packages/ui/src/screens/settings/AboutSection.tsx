import { PROTOCOL_VERSION } from "@psyche/protocol";
import { CircleAlert, CircleCheck, CircleX, Loader } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useCall } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { useUpdateStatus } from "../../shell/UpdateBanner.tsx";
import { useSlots } from "../../slots.tsx";
import { Facts, Group, SectionFrame } from "./shared.tsx";
import type {
  AboutInfo,
  DoctorCheck,
  UninstallPort,
  UpdatePort,
  UpdateStatusView,
} from "./types.ts";
import { UninstallGroupAction } from "./UninstallSheet.tsx";

/** About (UI design §3.18): versions, `psyche doctor`, logs. */

const DOCTOR_ICON = {
  ok: <CircleCheck className="size-4 text-success-text" aria-hidden="true" />,
  warn: <CircleAlert className="size-4 text-approval-text" aria-hidden="true" />,
  fail: <CircleX className="size-4 text-danger-text" aria-hidden="true" />,
};

export interface AboutPanelProps {
  info: AboutInfo | null;
  doctor?: readonly DoctorCheck[] | null;
  doctorRunning?: boolean;
  onRunDoctor?: () => void;
  onOpenLogs?: () => void;
  /** Desktop only: shows the data folder in Finder. */
  onRevealHome?: () => void;
  /** Desktop on the Mac or PC running the Gateway only: the Uninstall Psyche sheet. */
  uninstall?: UninstallPort;
  /** Desktop only: the release channel picker (the desktop app is the one that updates itself). */
  showUpdates?: boolean;
  /** Desktop on macOS: the app's update state and "Restart to update". */
  update?: UpdatePort;
}

/** The real state: "Up to date", "Psyche X is ready" with the restart, or why an update was refused. */
export function UpdateStatusValue({
  status,
  port,
}: {
  status: UpdateStatusView;
  port: UpdatePort;
}): ReactElement | null {
  const [error, setError] = useState<string | undefined>(undefined);
  if (status.state === "idle") return null;
  if (status.state === "checking") return <span>{t("settings.updates.checking")}</span>;
  if (status.state === "none") return <span>{t("settings.updates.upToDate")}</span>;
  if (status.state === "refused")
    return <span>{t("settings.updates.refused", { reason: status.reason })}</span>;
  const restart = (): void => {
    setError(undefined);
    port.restart().catch((err: unknown) => setError(describeError(err)));
  };
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span>
        {status.mandatory
          ? t("settings.updates.readyRequired", { version: status.release })
          : t("settings.updates.ready", { version: status.release })}
      </span>
      <Button type="button" size="sm" onClick={restart}>
        {t("shell.update.restart")}
      </Button>
      {error ? (
        <span role="alert" className="text-danger-text">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Settings > About > Updates: the release channel. Stable is the only channel until the release
 * pipeline publishes a beta manifest, so this shows it and says so; there is nothing to save. With
 * a port (macOS) it also shows the app's own update state.
 */
export function UpdateChannelGroup({ update }: { update?: UpdatePort }): ReactElement {
  const status = useUpdateStatus(update);
  return (
    <Group title={t("settings.updates.group")} description={t("settings.updates.hint")}>
      <div className="flex flex-col gap-2">
        <Facts
          items={[
            { term: t("settings.updates.channel"), value: t("settings.updates.channel.stable") },
            ...(update
              ? [
                  {
                    term: t("settings.updates.status"),
                    value: <UpdateStatusValue status={status} port={update} />,
                  },
                ]
              : []),
          ]}
        />
        <p className="text-callout text-label-secondary">{t("settings.updates.channel.note")}</p>
      </div>
    </Group>
  );
}

export function AboutPanel({
  info,
  doctor = null,
  doctorRunning = false,
  onRunDoctor,
  onOpenLogs,
  onRevealHome,
  uninstall,
  showUpdates = false,
  update,
}: AboutPanelProps): ReactElement {
  const { navigate } = useSlots();
  return (
    <SectionFrame title={t("settings.about.title")} description={t("settings.about.description")}>
      <Group title={t("settings.about.versions")} description={t("settings.about.versionsHint")}>
        <Facts
          items={[
            {
              term: t("settings.about.app"),
              value: info?.appVersion ?? t("settings.about.unknown"),
            },
            {
              term: t("settings.about.gateway"),
              value: info?.gatewayVersion ?? t("settings.about.unknown"),
            },
            {
              term: t("settings.about.protocol"),
              value: t("settings.about.protocolVersion", {
                version: info?.protocolVersion ?? PROTOCOL_VERSION,
              }),
            },
            ...(info ? [{ term: t("settings.about.platform"), value: info.platform }] : []),
            ...(info?.runtime ? [{ term: t("settings.about.runtime"), value: info.runtime }] : []),
            ...(info?.home
              ? [
                  {
                    term: t("settings.about.dataFolder"),
                    value: (
                      <span className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-callout break-all">{info.home}</code>
                        {onRevealHome ? (
                          <Button type="button" size="sm" variant="outline" onClick={onRevealHome}>
                            {t("settings.about.revealHome")}
                          </Button>
                        ) : null}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      </Group>
      {showUpdates ? <UpdateChannelGroup update={update} /> : null}
      {navigate ? (
        <Group
          title={t("onboarding.rerun.title")}
          description={t("onboarding.rerun.description")}
          actions={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => navigate("/onboarding")}
            >
              {t("onboarding.rerun.button")}
            </Button>
          }
        >
          {null}
        </Group>
      ) : null}
      <Group
        // i18n-ignore: the CLI command's name
        title="psyche doctor"
        description={t("settings.about.doctorDescription")}
        actions={
          <div className="flex gap-2">
            {onRunDoctor ? (
              <Button type="button" size="sm" onClick={onRunDoctor} disabled={doctorRunning}>
                {doctorRunning ? (
                  <>
                    <Loader className="motion-safe:animate-spin" aria-hidden="true" />{" "}
                    {t("settings.about.running")}
                  </>
                ) : (
                  t("settings.about.runChecks")
                )}
              </Button>
            ) : null}
            {onOpenLogs ? (
              <Button type="button" size="sm" variant="outline" onClick={onOpenLogs}>
                {t("settings.about.openLogs")}
              </Button>
            ) : null}
          </div>
        }
      >
        {doctor === null ? (
          <p className="text-muted-foreground">{t("settings.about.notRun")}</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-live="polite">
            {doctor.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                {DOCTOR_ICON[c.status]}
                <span>
                  <span className="font-medium">{c.label}</span>{" "}
                  <span className="sr-only">
                    {t("settings.about.doctorStatus", { status: c.status })}
                  </span>
                  <span className="text-muted-foreground">{c.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Group>
      {uninstall ? (
        <Group
          title={t("settings.uninstall.group")}
          description={t("settings.uninstall.groupHint")}
          actions={<UninstallGroupAction port={uninstall} />}
        >
          {null}
        </Group>
      ) : null}
    </SectionFrame>
  );
}

/**
 * The checks "Run checks" runs when the shell has its own `psyche doctor` to offer: each one a
 * Gateway call that already exists, so it says what is wrong in the owner's words.
 */
export function useDoctor(): {
  checks: DoctorCheck[] | null;
  running: boolean;
  run: () => void;
} {
  const call = useCall();
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  const run = useCallback(() => {
    setRunning(true);
    const check = async (
      id: string,
      label: string,
      fn: () => Promise<Omit<DoctorCheck, "id" | "label">>,
    ): Promise<DoctorCheck> => {
      try {
        return { id, label, ...(await fn()) };
      } catch (err) {
        return { id, label, status: "fail", detail: describeError(err) };
      }
    };
    void Promise.all([
      check("gateway", t("settings.doctor.gateway"), async () => {
        await call("settings.get", {});
        return { status: "ok", detail: t("settings.doctor.gatewayOk") };
      }),
      check("model", t("settings.doctor.model"), async () => {
        const r = await call("models.list", {});
        const ref = r.roles.primary;
        return ref
          ? { status: "ok", detail: ref }
          : { status: "warn", detail: t("settings.doctor.noModel") };
      }),
      check("sandbox", t("settings.doctor.sandbox"), async () => {
        const r = await call("sandbox.status", {});
        return r.available
          ? { status: "ok", detail: r.backend }
          : { status: "warn", detail: t("settings.doctor.noSandbox") };
      }),
      check("memory", t("settings.doctor.memory"), async () => {
        const r = await call("memory.status", {});
        return r.paused
          ? { status: "warn", detail: t("settings.doctor.memoryPaused") }
          : { status: "ok", detail: t("settings.doctor.memoryOk", { files: r.files }) };
      }),
    ])
      .then(setChecks)
      .finally(() => setRunning(false));
  }, [call]);
  return { checks, running, run };
}

/** About with "Run checks" wired to `useDoctor` unless the shell runs its own doctor. */
export function AboutSection(props: AboutPanelProps): ReactElement {
  const own = useDoctor();
  if (props.onRunDoctor) return <AboutPanel {...props} />;
  return (
    <AboutPanel {...props} doctor={own.checks} doctorRunning={own.running} onRunDoctor={own.run} />
  );
}
