import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { Group, StatusChip, type Tone } from "./shared.tsx";

/**
 * Settings → Devices on Linux: whether password approvals work (linux design §9.5, §9.6). The
 * Gateway's `devices.presence.status` row for `password`; `detail: "x11"` marks a ready X11
 * session, which gets the plain warning (an X11 client can read keystrokes).
 */
export interface PasswordPresenceRow {
  state: string;
  detail?: string | undefined;
}

const STATES = {
  ready: {
    chip: "settings.devices.password.state.ready",
    text: "settings.devices.password.detail.ready",
    tone: "success",
  },
  policy_missing: {
    chip: "settings.devices.password.state.policyMissing",
    text: "settings.devices.password.detail.policyMissing",
    tone: "danger",
  },
  not_enforced: {
    chip: "settings.devices.password.state.notEnforced",
    text: "settings.devices.password.detail.notEnforced",
    tone: "danger",
  },
  no_session: {
    chip: "settings.devices.password.state.noSession",
    text: "settings.devices.password.detail.noSession",
    tone: "neutral",
  },
  agent_missing: {
    chip: "settings.devices.password.state.agentMissing",
    text: "settings.devices.password.detail.agentMissing",
    tone: "danger",
  },
  unavailable: {
    chip: "settings.devices.password.state.unavailable",
    text: "settings.devices.password.detail.unavailable",
    tone: "neutral",
  },
} as const satisfies Record<string, { chip: string; text: string; tone: Tone }>;

export function PasswordPresenceGroup({ row }: { row: PasswordPresenceRow }): ReactElement {
  const s = STATES[row.state as keyof typeof STATES] ?? STATES.unavailable;
  return (
    <Group
      title={t("settings.devices.password.title")}
      description={t("settings.devices.password.description")}
    >
      <div className="flex flex-col gap-2" data-testid="password-presence">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={s.tone}>{t(s.chip)}</StatusChip>
          <span className="text-callout text-muted-foreground">{t(s.text)}</span>
        </div>
        {row.state === "ready" && row.detail === "x11" ? (
          <p
            className="text-callout text-label-primary"
            role="note"
            data-testid="password-x11-warning"
          >
            {t("settings.devices.password.x11Warning")}
          </p>
        ) : null}
      </div>
    </Group>
  );
}
