import { NOTIFICATION_SETTING_DEFAULTS as DEFAULTS } from "@psyche/protocol";
import type { ReactElement } from "react";
import { t } from "../../i18n/core.ts";
import { TimeRow } from "./MailMeetingsSection.tsx";
import {
  bool,
  Group,
  LoadGate,
  SectionFrame,
  type SettingsFormProps,
  SwitchField,
  str,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Notifications (#953): quiet hours. Off by default. Inside the window Psyche still
 * writes every notification to the inbox, but holds the ones that would interrupt (the OS, your
 * chats) until the window ends. Approvals marked time-sensitive still come through. The Gateway
 * reads these keys when each notification is sent, so a change applies to the next one.
 */

export interface NotificationsPanelProps extends Pick<SettingsFormProps, "values" | "onChange"> {
  needsApproval?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/** The presentational section; `NotificationsSection` feeds it from the Gateway. */
export function NotificationsPanel({
  values,
  onChange,
  needsApproval,
  loading = false,
  error = null,
  onRetry,
}: NotificationsPanelProps): ReactElement {
  const enabled = bool(
    values,
    "notifications.quietHours.enabled",
    DEFAULTS["notifications.quietHours.enabled"],
  );
  return (
    <SectionFrame
      title={t("settings.notifications.title")}
      description={t("settings.notifications.description")}
      needsApproval={needsApproval}
    >
      <LoadGate
        label={t("settings.notifications.title")}
        loading={loading}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group
          title={t("settings.notifications.group.quietHours")}
          description={t("settings.notifications.quietHours.hint")}
        >
          <SwitchField
            label={t("settings.key.notifications.quietHours.enabled")}
            settingKey="notifications.quietHours.enabled"
            checked={enabled}
            onChange={(v) => onChange("notifications.quietHours.enabled", v)}
          />
          <TimeRow
            label={t("settings.key.notifications.quietHours.start")}
            value={str(
              values,
              "notifications.quietHours.start",
              DEFAULTS["notifications.quietHours.start"],
            )}
            disabled={!enabled}
            onCommit={(v) => onChange("notifications.quietHours.start", v)}
          />
          <TimeRow
            label={t("settings.key.notifications.quietHours.end")}
            value={str(
              values,
              "notifications.quietHours.end",
              DEFAULTS["notifications.quietHours.end"],
            )}
            disabled={!enabled}
            onCommit={(v) => onChange("notifications.quietHours.end", v)}
          />
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

/** Connected: `settings.*` from the Gateway. */
export function NotificationsSection(): ReactElement {
  const form = useSettingsForm();
  return (
    <NotificationsPanel
      values={form.values}
      onChange={form.onChange}
      needsApproval={form.needsApproval}
      loading={form.loading && Object.keys(form.values).length === 0}
      error={form.error}
      onRetry={form.reload}
    />
  );
}
