import type { Grant } from "@psyche/protocol";
import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { formatRelative } from "../../lib/format.ts";
import { grantSubject } from "./PermissionsSection.tsx";
import { EmptyNotice, Group } from "./shared.tsx";

/** What the owner has allowed for good, in the order the list shows it. */
export const ALLOWED_GROUPS = ["sites", "folders", "commands", "sends", "tools", "spaces"] as const;
export type AllowedGroup = (typeof ALLOWED_GROUPS)[number];

/** Which group a grant belongs to, from what it is a grant of. */
export function allowedGroupOf(g: Grant): AllowedGroup {
  const s = g.subject as Record<string, unknown>;
  if (typeof s.space === "object" && s.space !== null) return "spaces";
  if (typeof s.spaceId === "string") return "spaces";
  switch (g.kind) {
    case "new_origin":
    case "credential_fill":
      return "sites";
    case "folder_access":
    case "file_write":
      return "folders";
    case "exec":
    case "exec_host":
      return "commands";
    case "send_email":
    case "message_send":
    case "calendar_write":
      return "sends";
    default:
      return "tools";
  }
}

const SCOPE_WORDS = ["always", "session", "site", "task"] as const;

/** "Always · runs pnpm in ~/Projects/x · used 12 times · last Tue", from what the grant records. */
export function allowedRowText(g: Grant, now: number): string {
  const subject = grantSubject(g);
  const what =
    g.kind === "exec" || g.kind === "exec_host"
      ? t("approvals.allowed.runs", { what: subject })
      : g.kind === "send_email"
        ? t("approvals.allowed.sends", { what: subject })
        : subject;
  const scope = SCOPE_WORDS.find((w) => w === g.scope);
  const parts = [
    scope === undefined ? null : t(`approvals.allowed.scope.${scope}`),
    what,
    g.useCount > 0 ? t("approvals.allowed.used", { n: g.useCount }) : null,
    g.lastUsedAt ? t("approvals.allowed.last", { when: formatRelative(g.lastUsedAt, now) }) : null,
  ];
  return parts.filter((p): p is string => p !== null && p !== "").join(" · ");
}

/**
 * Settings → Permissions → Allowed: one list of everything the owner allowed for good, grouped by
 * kind of thing, each row in plain words with Remove (the existing `grants.revoke`). The older
 * per-kind lists sit under Details below it.
 */
export function AllowedList({
  grants,
  now,
  onRevoke,
  revoking,
}: {
  grants: readonly Grant[];
  now: number;
  onRevoke?: (grant: Grant) => void;
  revoking?: ReadonlySet<string> | undefined;
}): ReactElement {
  const live = grants.filter(
    (g) =>
      g.revokedAt == null &&
      g.scope !== "once" &&
      (g.expiresAt == null || Date.parse(g.expiresAt) > now),
  );
  return (
    <Group title={t("approvals.allowed.title")} description={t("approvals.allowed.description")}>
      {live.length === 0 ? (
        <EmptyNotice text={t("approvals.allowed.empty")} />
      ) : (
        <div className="flex flex-col gap-4" data-testid="allowed-list">
          {ALLOWED_GROUPS.map((group) => {
            const rows = live.filter((g) => allowedGroupOf(g) === group);
            if (rows.length === 0) return null;
            return (
              <section key={group} aria-label={t(`approvals.allowed.group.${group}`)}>
                <h4 className="mb-1 text-callout font-medium text-label-secondary">
                  {t(`approvals.allowed.group.${group}`)}
                </h4>
                <ul className="flex flex-col divide-y divide-separator">
                  {rows.map((g) => (
                    <li key={g.id} className="flex items-center gap-2 py-1.5">
                      <span className="min-w-0 flex-1 text-body">{allowedRowText(g, now)}</span>
                      {onRevoke ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          disabled={revoking?.has(g.id) ?? false}
                          aria-label={t("approvals.allowed.removeNamed", {
                            name: grantSubject(g),
                          })}
                          onClick={() => onRevoke(g)}
                        >
                          {t("approvals.allowed.remove")}
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </Group>
  );
}
