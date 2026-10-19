import { PROTOCOL_VERSION } from "@psyche/protocol";
import { CircleAlert, CircleCheck, CircleX, Loader } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Facts, Group, SectionFrame } from "./shared.tsx";
import type { AboutInfo, DoctorCheck } from "./types.ts";

/** About (UI design §3.18): versions, `psyche doctor`, logs. */

const DOCTOR_ICON = {
  ok: <CircleCheck className="size-4 text-success-text" aria-hidden="true" />,
  warn: <CircleAlert className="size-4 text-approval-text" aria-hidden="true" />,
  fail: <CircleX className="size-4 text-danger-text" aria-hidden="true" />,
};

const DOCTOR_TEXT = { ok: "OK", warn: "Warning", fail: "Failed" };

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
    <SectionFrame title="About" description="Psyche is open source under the Apache 2.0 license.">
      <Group title="Versions">
        <Facts
          items={[
            { term: "App", value: info?.appVersion ?? "unknown" },
            { term: "Gateway", value: info?.gatewayVersion ?? "unknown" },
            { term: "Protocol", value: `v${info?.protocolVersion ?? PROTOCOL_VERSION}` },
            ...(info ? [{ term: "Platform", value: info.platform }] : []),
            ...(info
              ? [
                  {
                    term: "Data folder",
                    value: <code className="font-mono text-xs">{info.home}</code>,
                  },
                ]
              : []),
          ]}
        />
      </Group>
      <Group
        title="psyche doctor"
        description="Checks the Gateway, sandbox, permissions and vault."
        actions={
          <div className="flex gap-2">
            {onRunDoctor ? (
              <Button type="button" size="sm" onClick={onRunDoctor} disabled={doctorRunning}>
                {doctorRunning ? (
                  <>
                    <Loader className="motion-safe:animate-spin" aria-hidden="true" /> Running
                  </>
                ) : (
                  "Run checks"
                )}
              </Button>
            ) : null}
            {onOpenLogs ? (
              <Button type="button" size="sm" variant="outline" onClick={onOpenLogs}>
                Open logs
              </Button>
            ) : null}
          </div>
        }
      >
        {doctor === null ? (
          <p className="text-muted-foreground">Not run yet.</p>
        ) : (
          <ul className="flex flex-col gap-1" aria-live="polite">
            {doctor.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                {DOCTOR_ICON[c.status]}
                <span>
                  <span className="font-medium">{c.label}</span>{" "}
                  <span className="sr-only">{DOCTOR_TEXT[c.status]}: </span>
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
