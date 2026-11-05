import type { ReactElement } from "react";
import { isMessageId, t } from "../../i18n/core.ts";
import { Group, StatusChip, type Tone } from "./shared.tsx";

/**
 * Settings → Devices on Linux: what the Gateway saw of the helper's process when it connected, and
 * why a helper was turned away (`devices.hostHelper.status`, linux design §4.3). Nothing shows
 * where the Gateway records neither (macOS and Windows).
 */
export interface HostHelperStatus {
  peerCheck?: string;
  refused?: { peerCheck: string; reason: string };
}

/** The setting the Gateway writes. */
export const HOST_HELPER_STATUS_KEY = "devices.hostHelper.status";

/** Reads the setting's value defensively: an unknown shape shows nothing, never breaks the page. */
export function parseHostHelperStatus(value: unknown): HostHelperStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const out: HostHelperStatus = {};
  if (typeof v.peerCheck === "string") out.peerCheck = v.peerCheck;
  const r = v.refused;
  if (typeof r === "object" && r !== null) {
    const rr = r as Record<string, unknown>;
    if (typeof rr.peerCheck === "string" && typeof rr.reason === "string") {
      out.refused = { peerCheck: rr.peerCheck, reason: rr.reason };
    }
  }
  return out.peerCheck === undefined && out.refused === undefined ? undefined : out;
}

const STATES = {
  root_owned: {
    chip: "settings.devices.helperCheck.state.verified",
    detail: "settings.devices.helperCheck.detail.verified",
    tone: "success",
  },
  user_owned: {
    chip: "settings.devices.helperCheck.state.userOwned",
    detail: "settings.devices.helperCheck.detail.userOwned",
    tone: "neutral",
  },
  unverified: {
    chip: "settings.devices.helperCheck.state.unverified",
    detail: "settings.devices.helperCheck.detail.unverified",
    tone: "neutral",
  },
} as const satisfies Record<string, { chip: string; detail: string; tone: Tone }>;

/** The Gateway's machine reasons, in the words an owner reads (anything else: unclear). */
const REASONS: Readonly<Record<string, string>> = {
  not_helper: "notHelper",
  user_binary: "userCopy",
  loader_env: "loaderEnv",
  foreign_mapping: "foreignCode",
  many_holders: "severalPrograms",
  inherited_socket: "handedOver",
  not_ready: "stillStarting",
  stopped_or_traced: "debugged",
  library_replaced: "restartNeeded",
  binary_replaced: "restartNeeded",
  root_owned_outside_package: "filesNotLocked",
  helper_writable: "filesNotLocked",
  dir_writable: "filesNotLocked",
  path_remounted: "filesNotLocked",
  other_namespace: "otherNamespace",
  busy: "busy",
};

/** The sentence for a refusal reason: "Refused: it was still starting up". */
export function refusedText(reason: string): string {
  const id = `settings.devices.helperCheck.reason.${REASONS[reason] ?? "unclear"}`;
  const why = isMessageId(id) ? t(id) : t("settings.devices.helperCheck.reason.unclear");
  return t("settings.devices.helperCheck.refused", { reason: why });
}

export function HostHelperCheckGroup({ status }: { status: HostHelperStatus }): ReactElement {
  const s =
    status.peerCheck === undefined ? undefined : STATES[status.peerCheck as keyof typeof STATES];
  return (
    <Group
      title={t("settings.devices.helperCheck.title")}
      description={t("settings.devices.helperCheck.description")}
    >
      <div className="flex flex-col gap-2" data-testid="host-helper-check">
        {s ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="host-helper-check-state">
            <StatusChip tone={s.tone}>{t(s.chip)}</StatusChip>
            <span className="text-callout text-muted-foreground">{t(s.detail)}</span>
          </div>
        ) : null}
        {status.refused ? (
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="host-helper-check-refused"
          >
            <StatusChip tone="danger">{refusedText(status.refused.reason)}</StatusChip>
          </div>
        ) : null}
      </div>
    </Group>
  );
}
