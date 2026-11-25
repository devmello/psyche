import { NOTIFICATION_SETTING_DEFAULTS as DEFAULTS } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { TimeRow } from "./MailMeetingsSection.tsx";
import {
  bool,
  Group,
  LoadGate,
  SectionFrame,
  type SettingsFormProps,
  StatusChip,
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

/** Psyche Helper's own notification permission (approval notifications go through the helper). */
export interface HelperNotifications {
  /** `offline`: the helper is not connected, so nothing is known (never shown as allowed). */
  state: "granted" | "denied" | "not_determined" | "offline";
  onAllow: () => void;
}

export interface NotificationsPanelProps extends Pick<SettingsFormProps, "values" | "onChange"> {
  helperNotifications?: HelperNotifications;
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
  helperNotifications,
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
        {helperNotifications ? (
          <Group
            title={t("settings.notifications.helper.title")}
            description={t("settings.notifications.helper.hint")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip
                tone={
                  helperNotifications.state === "granted"
                    ? "success"
                    : helperNotifications.state === "denied"
                      ? "danger"
                      : "neutral"
                }
              >
                {t(
                  `settings.computerUse.tccState.${helperNotifications.state === "offline" ? "offline" : helperNotifications.state}`,
                )}
              </StatusChip>
              {helperNotifications.state === "offline" ? (
                <span className="text-callout text-muted-foreground">
                  {t("settings.computerUse.helperAccess.offline")}
                </span>
              ) : helperNotifications.state === "denied" ? (
                <>
                  <span className="text-callout text-muted-foreground">
                    {t("settings.notifications.helper.denied")}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="ms-auto"
                    onClick={helperNotifications.onAllow}
                  >
                    {t("settings.notifications.helper.openSettings")}
                  </Button>
                </>
              ) : helperNotifications.state !== "granted" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="ms-auto"
                  onClick={helperNotifications.onAllow}
                >
                  {t("settings.notifications.helper.allow")}
                </Button>
              ) : null}
            </div>
          </Group>
        ) : null}
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
export function NotificationsSection({
  helperNotifications,
}: {
  helperNotifications?: HelperNotifications;
}): ReactElement {
  const form = useSettingsForm();
  return (
    <NotificationsPanel
      {...(helperNotifications ? { helperNotifications } : {})}
      values={form.values}
      onChange={form.onChange}
      needsApproval={form.needsApproval}
      loading={form.loading && Object.keys(form.values).length === 0}
      error={form.error}
      onRetry={form.reload}
    />
  );
}
