import { PROTOCOL_VERSION } from "@psyche/protocol";
import { CircleAlert, CircleCheck, CircleX, Loader } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { Facts, Group, SectionFrame } from "./shared.tsx";
import type { AboutInfo, DoctorCheck } from "./types.ts";

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
}

export function AboutPanel({
  info,
  doctor = null,
  doctorRunning = false,
  onRunDoctor,
  onOpenLogs,
}: AboutPanelProps): ReactElement {
  return (
    <SectionFrame title={t("settings.about.title")} description={t("settings.about.description")}>
      <Group title={t("settings.about.versions")}>
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
            ...(info
              ? [
                  {
                    term: t("settings.about.dataFolder"),
                    value: <code className="font-mono text-xs">{info.home}</code>,
                  },
                ]
              : []),
          ]}
        />
      </Group>
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
    </SectionFrame>
  );
}

/** The shell supplies versions and runs `psyche doctor`; the Gateway has no method for either. */
export const AboutSection = AboutPanel;
