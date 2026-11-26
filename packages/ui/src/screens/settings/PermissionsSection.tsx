import type { Connector, Grant } from "@psyche/protocol";
import { ShieldOff } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { formatDate, formatRelative } from "../../lib/format.ts";
import { parseSendGrantKey, splitRecipients } from "../../lib/send-grant.ts";
import { useNow } from "../../lib/use-now.ts";
import { useSlots } from "../../slots.tsx";
import { ActionMatrix, type ActionRule, withMatrixOverrides } from "./ActionMatrix.tsx";
import { AllowedList } from "./AllowedList.tsx";
import { appleApp } from "./ConnectorCapabilities.tsx";
import { SCOPE_MODE_LABEL } from "./ConnectorsSection.tsx";
import { execReviewInAuto, policyWithExecReview } from "./FileAccessSection.tsx";
import { PaneRows } from "./PaneRows.tsx";
import type { SettingsPaneId } from "./settings-pages.ts";
import {
  Advanced,
  bool,
  EmptyNotice,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  messageOf,
  RadioField,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  StatusChip,
  SwitchField,
  str,
  useSettingsForm,
} from "./shared.tsx";

/** Permissions (UI design §3.18; architecture §4.6, §4.9; security §3.9). */

export type PermissionMode = "manual" | "balanced" | "auto";

const modeOption = <V extends PermissionMode>(value: V) => ({
  value,
  get label(): string {
    return t(`settings.permissions.mode.${value as PermissionMode}`);
  },
  get hint(): string {
    return t(`settings.permissions.mode.${value as PermissionMode}Hint`);
  },
});

// Manual · Balanced · Auto, the order the chat header's mode menu uses.
export const MODE_OPTIONS = [modeOption("manual"), modeOption("balanced"), modeOption("auto")];

/** Security §3.9 / architecture §4.6: not configurable, shown read-only. */
export const HARD_PROHIBITION_IDS = [
  "secrets",
  "captcha",
  "money",
  "delete",
  "injection",
  "accounts",
  "localhost",
  "selfChange",
  "browserPasswords",
  "seenSecret",
] as const;

/** The hard prohibitions, one sentence each, in the active language. */
export function hardProhibitions(): string[] {
  return HARD_PROHIBITION_IDS.map((id) => t(`settings.permissions.never.${id}`));
}

const GRANT_KINDS = [
  "new_origin",
  "connector_action",
  "send_email",
  "calendar_write",
  "exec",
  "file_write",
  "mcp_tool",
  "credential_fill",
  "computer_action",
] as const satisfies readonly Grant["kind"][];

/** A grant kind as the owner reads it; a kind without words shows as written. */
export function grantKindLabel(kind: Grant["kind"]): string {
  const known = GRANT_KINDS.find((k) => k === kind);
  return known === undefined ? kind : t(`settings.permissions.kind.${known}`);
}

const scopeLabel = (s: Grant["scope"]): string => t(`settings.permissions.scope.${s}`);

/** The trusted-site entry of a grant ("Always for this site"), or null for any other grant. */
export function trustedSiteOf(
  g: Grant,
): { origin: string; display: string; subdomains: boolean } | null {
  const o = (g.subject as Record<string, unknown>).trustedSite;
  if (g.kind !== "new_origin" || typeof o !== "object" || o === null) return null;
  const { origin, subdomains } = o as { origin?: unknown; subdomains?: unknown };
  if (typeof origin !== "string") return null;
  return { origin, display: origin.replace(/^https:\/\//, ""), subdomains: subdomains === true };
}

/**
 * The full executable path of a host-program grant, for a second line under `grantSubject`: the
 * subject shows the basename only, which makes `/tmp/x/git` look like `/usr/bin/git`. Null otherwise.
 */
export function grantExecutable(g: Grant): string | null {
  const hp = g.subject.hostProgram as { executable?: unknown } | null | undefined;
  return g.kind === "exec_host" && hp && typeof hp.executable === "string" ? hp.executable : null;
}

/** One line naming exactly what a grant covers. */
export function grantSubject(g: Grant): string {
  const s = g.subject;
  const text = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : null);
  const trusted = trustedSiteOf(g);
  if (trusted !== null)
    return trusted.subdomains
      ? t("settings.permissions.subject.trustedSiteSubdomains", { origin: trusted.display })
      : trusted.display;
  if (g.kind === "new_origin")
    return t("settings.permissions.subject.origin", {
      origin: (text("origin") ?? g.grantKey).replace(/^https?:\/\//, ""),
      access: text("access") ?? "r",
    });
  // The standing grant for meeting-prep notes covers one title class, so it says so (security §3.5).
  if (g.kind === "connector_action" && text("titlePrefix") === "Prep:")
    return t("settings.permissions.subject.prepNotes");
  if (g.kind === "connector_action" || g.kind === "mcp_tool")
    return text("action") ?? text("tool") ?? g.grantKey;
  // "Always allow <program> in <folder>": the binary's name and the folder it is bound to.
  const hp = s.hostProgram as
    | { executable?: unknown; folder?: unknown; argv?: unknown }
    | null
    | undefined;
  if (g.kind === "exec_host" && hp && typeof hp.executable === "string") {
    const folder = typeof hp.folder === "string" ? hp.folder : "";
    if (Array.isArray(hp.argv)) {
      return t("settings.permissions.subject.hostProgramExact", {
        program: (hp.argv as unknown[]).join(" "),
        folder,
      });
    }
    return t("settings.permissions.subject.hostProgram", {
      program: hp.executable.split("/").pop() ?? hp.executable,
      folder,
    });
  }
  if (g.kind === "exec" && Array.isArray(s.argv)) {
    const argv = (s.argv as unknown[]).join(" ");
    const cwd = text("cwd");
    return cwd ? t("settings.permissions.subject.execIn", { argv, cwd }) : argv;
  }
  if (g.kind === "send_email") {
    // The broker stores `target` (the recipient set) and the account in the grant key; a send
    // grant never reads as "any recipient".
    const target = s.target as { kind?: unknown; value?: unknown } | undefined;
    const key = parseSendGrantKey(g.grantKey);
    const recipients =
      target?.kind === "recipient" && typeof target.value === "string"
        ? splitRecipients(target.value)
        : (key?.recipients ?? []);
    if (recipients.length === 0) return g.grantKey;
    const list = recipients.join(", ");
    const account = text("account") ?? key?.account ?? null;
    return account
      ? t("settings.permissions.subject.emailFrom", { recipients: list, account })
      : t("settings.permissions.subject.emailTo", { recipient: list });
  }
  if (g.kind === "calendar_write") {
    const id = text("calendarId")?.trim();
    return id
      ? t("settings.permissions.subject.calendarNamed", { id })
      : t("settings.permissions.subject.calendar");
  }
  return g.grantKey;
}

/** `lastSync.toolsListChanged` marks an MCP server whose tools/list hash changed. */
export function toolsListChanged(c: Connector): boolean {
  return c.type === "mcp" && c.lastSync?.toolsListChanged === true;
}

export interface PermissionsPanelProps extends SettingsFormProps, LoadProps {
  connectors: readonly Connector[];
  grants: readonly Grant[];
  now?: number;
  onRevoke?: (grant: Grant) => void;
  /** Per-connector matrix change; the connected screen writes `permissions.connectors.<id>`. */
  onRuleChange?: (connector: Connector, action: string, rule: ActionRule) => void;
  /** Opens Settings → Connectors, where a specific connector's permissions are set. */
  onOpenConnectors?: () => void;
  /** Opens a pane one level deeper (the Access rows and Credentials); no rows without it. */
  onOpenPane?: (pane: SettingsPaneId) => void;
  /** Grant ids being revoked, for disabled buttons. */
  revoking?: ReadonlySet<string>;
  revokeError?: string | null;
}

export function PermissionsPanel({
  values,
  onChange,
  needsApproval,
  connectors,
  grants,
  now,
  onRevoke,
  onRuleChange,
  onOpenConnectors,
  onOpenPane,
  revoking,
  revokeError = null,
  loading,
  error,
  onRetry,
}: PermissionsPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const [showProhibitions, setShowProhibitions] = useState(false);
  const mode = str(values, "permissions.mode", "balanced") as PermissionMode;
  const trusted = grants.filter((g) => trustedSiteOf(g) !== null && g.revokedAt === null);
  const origins = grants.filter(
    (g) => g.kind === "new_origin" && g.revokedAt === null && trustedSiteOf(g) === null,
  );
  // Per-recipient sends the owner chose "always" for; Remove asks again next time.
  const sends = grants.filter((g) => g.kind === "send_email" && g.revokedAt === null);
  const active = grants.filter((g) => g.revokedAt === null);
  // Apple apps set their actions on their own card in Connectors, not here (#640).
  const rows = connectors.filter((c) => appleApp(c.type) === null);

  return (
    <SectionFrame needsApproval={needsApproval} title={t("settings.page.permissions")}>
      <LoadGate
        label={t("settings.permissions.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group
          title={t("settings.drill.asking")}
          description={t("settings.permissions.defaultModeTitle")}
        >
          <RadioField
            label={t("settings.key.permissions.mode")}
            hideLabel
            value={mode}
            options={MODE_OPTIONS}
            settingKey="permissions.mode"
            onChange={(v) => onChange("permissions.mode", v)}
          ></RadioField>
          {/* A sealed security setting: turning it on asks, turning it off applies at once. */}
          <SwitchField
            label={t("settings.permissions.execReview")}
            description={t("settings.permissions.execReviewHint")}
            checked={execReviewInAuto(values)}
            onChange={(on) => onChange("permissions.policy", policyWithExecReview(values, on))}
          />
        </Group>

        {/* Where the agent may reach: each row opens its pane one level deeper. */}
        {onOpenPane ? (
          <>
            <Group title={t("settings.drill.access")}>
              <PaneRows
                bare
                panes={["computer-use", "browser", "files"]}
                onOpen={onOpenPane}
                labels={{ files: t("settings.drill.access.files") }}
              />
            </Group>
            <PaneRows panes={["credentials", "data"]} onOpen={onOpenPane} />
          </>
        ) : null}

        {/* One list of everything allowed for good; the older per-kind lists are under Details. */}
        <AllowedList
          grants={grants}
          now={clock}
          {...(onRevoke ? { onRevoke } : {})}
          revoking={revoking}
          error={revokeError}
        />

        {/* One grouped list per connector, rows per action (redesign §5.8). */}
        <Advanced
          title={t("settings.permissions.connectorActions")}
          description={t("settings.permissions.connectorActionsHint")}
        >
          {connectors.length === 0 ? (
            <EmptyNotice text={t("settings.permissions.noConnectors")} />
          ) : (
            rows.map((c) => {
              const changed = toolsListChanged(c);
              const key = `permissions.connectors.${c.id}`;
              const hash = c.config.toolsListHash;
              return (
                <div key={c.id} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-2 px-1">
                    <h4 className="text-headline text-label-primary">
                      {c.label}{" "}
                      <span className="font-normal text-label-secondary">
                        {t("settings.permissions.scopeMode", {
                          mode: SCOPE_MODE_LABEL[c.scopeMode].toLocaleLowerCase(
                            activeI18n().locale,
                          ),
                        })}
                      </span>
                    </h4>
                    {c.type === "mcp" ? (
                      changed ? (
                        <StatusChip tone="danger">
                          <ShieldOff className="size-3" aria-hidden="true" />{" "}
                          {t("settings.permissions.grantsRevoked")}
                        </StatusChip>
                      ) : (
                        <StatusChip tone="success">{t("settings.permissions.hashOk")}</StatusChip>
                      )
                    ) : null}
                  </div>
                  <ActionMatrix
                    connectorLabel={c.label}
                    matrix={c.actionMatrix}
                    onChange={(action, rule) => onRuleChange?.(c, action, rule)}
                    disabled={onRuleChange === undefined}
                  />
                  {changed ? (
                    <p className="px-1 text-callout text-label-primary">
                      {t("settings.permissions.toolsChanged", { name: c.label })}
                    </p>
                  ) : null}
                  {c.type === "mcp" && typeof hash === "string" ? (
                    <details className="px-1 text-callout text-label-secondary">
                      <summary className="w-fit cursor-default select-none hover:text-label-primary">
                        {t("settings.browser.details")}
                      </summary>
                      <p className="mt-1 truncate font-mono">
                        {t("settings.permissions.hash", { hash: hash.slice(0, 19) })}
                      </p>
                    </details>
                  ) : null}
                  <SettingHint settingKey={key} />
                </div>
              );
            })
          )}
          <div className="flex flex-wrap items-center gap-2 px-1">
            <p className="text-callout text-label-secondary">
              {t("settings.permissions.specificConnectors")}
            </p>
            {onOpenConnectors ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenConnectors}>
                {t("settings.permissions.openConnectors")}
              </Button>
            ) : null}
          </div>
        </Advanced>

        <Group
          title={t("settings.permissions.sensitive.title")}
          description={t("settings.permissions.sensitive.description")}
        >
          <SwitchField
            label={t("settings.key.permissions.sensitive.government")}
            description={t("settings.permissions.sensitive.governmentHint")}
            checked={bool(values, "permissions.sensitive.government", true)}
            settingKey="permissions.sensitive.government"
            onChange={(on) => onChange("permissions.sensitive.government", on)}
          />
          <SwitchField
            label={t("settings.key.permissions.sensitive.icloud")}
            description={t("settings.permissions.sensitive.icloudHint")}
            checked={bool(values, "permissions.sensitive.icloud", true)}
            settingKey="permissions.sensitive.icloud"
            onChange={(on) => onChange("permissions.sensitive.icloud", on)}
          />
        </Group>

        <Advanced title={t("approvals.allowed.details")}>
          <Group
            title={t("settings.permissions.trusted.title")}
            description={t("settings.permissions.trusted.description")}
          >
            {trusted.length === 0 ? (
              <EmptyNotice text={t("settings.permissions.trusted.empty")} />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {trusted.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{grantSubject(g)}</span>
                    <span className="text-callout text-muted-foreground">
                      {t("settings.permissions.trusted.added", { date: formatDate(g.createdAt) })}
                    </span>
                    {onRevoke ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => onRevoke(g)}
                        disabled={revoking?.has(g.id) ?? false}
                        aria-label={t("settings.permissions.trusted.removeNamed", {
                          name: grantSubject(g),
                        })}
                      >
                        {t("settings.permissions.trusted.remove")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Group>

          <Group
            title={t("settings.permissions.sendsTitle")}
            description={t("settings.permissions.sendsHint")}
          >
            {sends.length === 0 ? (
              <EmptyNotice text={t("settings.permissions.noSends")} />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {sends.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{grantSubject(g)}</span>
                    {onRevoke ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => onRevoke(g)}
                        disabled={revoking?.has(g.id) ?? false}
                        aria-label={t("settings.permissions.revokeNamed", {
                          name: grantSubject(g),
                        })}
                      >
                        {t("settings.devices.revoke")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Group>

          <Group
            title={t("settings.permissions.origins")}
            description={t("settings.permissions.originsHint")}
          >
            {origins.length === 0 ? (
              <EmptyNotice text={t("settings.permissions.noOrigins")} />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {origins.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{grantSubject(g)}</span>
                    <span className="text-callout text-muted-foreground">
                      {g.expiresAt
                        ? t("settings.permissions.scopeExpires", {
                            scope: scopeLabel(g.scope),
                            date: formatDate(g.expiresAt),
                          })
                        : scopeLabel(g.scope)}
                    </span>
                    {onRevoke ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => onRevoke(g)}
                        disabled={revoking?.has(g.id) ?? false}
                        aria-label={t("settings.permissions.revokeNamed", {
                          name: grantSubject(g),
                        })}
                      >
                        {t("settings.devices.revoke")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Group>

          <Group
            title={t("settings.permissions.ledger")}
            description={t("settings.permissions.ledgerHint", { n: active.length })}
          >
            {revokeError ? (
              <ErrorNotice what={revokeError} did={t("settings.permissions.grantUnchanged")} />
            ) : null}
            {grants.length === 0 ? (
              <EmptyNotice text={t("settings.permissions.noGrants")} />
            ) : (
              <Table aria-label={t("settings.permissions.ledger")}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">{t("settings.permissions.col.grant")}</TableHead>
                    <TableHead scope="col">{t("settings.permissions.col.scope")}</TableHead>
                    <TableHead scope="col">{t("settings.credentials.col.uses")}</TableHead>
                    <TableHead scope="col">{t("settings.credentials.col.lastUsed")}</TableHead>
                    <TableHead scope="col">
                      <span className="sr-only">{t("settings.credentials.col.actions")}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grants.map((g) => (
                    <TableRow key={g.id} data-revoked={g.revokedAt !== null}>
                      <TableCell className="whitespace-normal">
                        <span className="block text-callout text-muted-foreground">
                          {grantKindLabel(g.kind)}
                        </span>
                        <span className={g.revokedAt ? "text-muted-foreground line-through" : ""}>
                          {grantSubject(g)}
                        </span>
                        {grantExecutable(g) ? (
                          <span className="block break-all font-mono text-callout text-muted-foreground">
                            {grantExecutable(g)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {scopeLabel(g.scope)}
                        {g.expiresAt ? (
                          <span className="block text-callout text-muted-foreground">
                            {Date.parse(g.expiresAt) < clock
                              ? t("settings.permissions.expired")
                              : t("settings.permissions.until", { date: formatDate(g.expiresAt) })}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {activeI18n().number(g.useCount)}
                      </TableCell>
                      <TableCell>
                        {g.lastUsedAt
                          ? formatRelative(g.lastUsedAt, clock)
                          : t("settings.permissions.never")}
                      </TableCell>
                      <TableCell className="text-end">
                        {g.revokedAt ? (
                          <StatusChip tone="neutral">
                            {t("settings.permissions.revoked")}
                          </StatusChip>
                        ) : onRevoke ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() => onRevoke(g)}
                            disabled={revoking?.has(g.id) ?? false}
                            aria-label={t("settings.permissions.revokeNamed", {
                              name: grantSubject(g),
                            })}
                          >
                            {t("settings.devices.revoke")}
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Group>
        </Advanced>

        <Group
          title={t("settings.permissions.hard")}
          description={t("settings.permissions.hardHint")}
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={showProhibitions}
              aria-controls="psyche-hard-prohibitions"
              onClick={() => setShowProhibitions((v) => !v)}
            >
              {showProhibitions ? t("settings.permissions.hide") : t("settings.permissions.show")}
            </Button>
          }
        >
          {showProhibitions ? (
            <ul id="psyche-hard-prohibitions" className="list-disc ps-8! text-label-secondary">
              {HARD_PROHIBITION_IDS.map((id) => (
                <li key={id}>{t(`settings.permissions.never.${id}`)}</li>
              ))}
            </ul>
          ) : (
            <span id="psyche-hard-prohibitions" hidden />
          )}
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export { withMatrixOverrides } from "./ActionMatrix.tsx";

export function PermissionsSection({
  now,
  onOpenPane,
}: {
  now?: number;
  onOpenPane?: (pane: SettingsPaneId) => void;
}): ReactElement {
  const form = useSettingsForm();
  const call = useCall();
  const { navigate } = useSlots();
  const connectorsQ = useGatewayQuery("connectors.list", {});
  const grantsQ = useGatewayQuery("grants.list", { includeRevoked: true });
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(() => new Set());
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const reloadGrants = grantsQ.reload;

  const onRevoke = useCallback(
    (g: Grant) => {
      setRevokeError(null);
      setRevoking((s) => new Set(s).add(g.id));
      call("grants.revoke", { grantId: g.id })
        .then(
          () => reloadGrants(),
          (err: unknown) =>
            setRevokeError(
              t("settings.permissions.revokeFailed", {
                name: grantSubject(g),
                reason: messageOf(err),
              }),
            ),
        )
        .finally(() =>
          setRevoking((s) => {
            const next = new Set(s);
            next.delete(g.id);
            return next;
          }),
        );
    },
    [call, reloadGrants],
  );

  const connectors = withMatrixOverrides(connectorsQ.data?.connectors ?? [], form.values);
  const loading =
    (connectorsQ.loading && connectorsQ.data === undefined) ||
    (grantsQ.loading && grantsQ.data === undefined);
  const error = connectorsQ.error ?? grantsQ.error ?? form.error;

  return (
    <div className="flex flex-col gap-3">
      <PermissionsPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        connectors={connectors}
        grants={grantsQ.data?.grants ?? []}
        onRevoke={onRevoke}
        onRuleChange={(c, action, rule) =>
          form.onChange(`permissions.connectors.${c.id}`, { ...c.actionMatrix, [action]: rule })
        }
        onOpenConnectors={() => navigate?.("/settings/connectors")}
        {...(onOpenPane ? { onOpenPane } : {})}
        revoking={revoking}
        revokeError={revokeError}
        loading={loading}
        error={error}
        onRetry={() => {
          connectorsQ.reload();
          grantsQ.reload();
          form.reload();
        }}
        {...(now === undefined ? {} : { now })}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
