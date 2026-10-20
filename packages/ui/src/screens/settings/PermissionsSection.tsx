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
import { formatDate, formatRelative, plural } from "../../lib/format.ts";
import { useNow } from "../../lib/use-now.ts";
import { useSlots } from "../../slots.tsx";
import { ActionMatrix, type ActionRule } from "./ActionMatrix.tsx";
import { SCOPE_MODE_LABEL } from "./ConnectorsSection.tsx";
import { folderGrants } from "./FileAccessSection.tsx";
import {
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
  str,
  useSettingsForm,
} from "./shared.tsx";
import type { FolderGrant } from "./types.ts";

/** Permissions (UI design §3.18; architecture §4.6, §4.9; security §3.9). */

export type PermissionMode = "manual" | "balanced" | "auto";

export const MODE_OPTIONS = [
  {
    value: "balanced" as const,
    label: "Balanced",
    hint: "Reads run; writes to people and money ask first.",
  },
  { value: "manual" as const, label: "Manual", hint: "Every action outside a grant asks first." },
  {
    value: "auto" as const,
    label: "Auto",
    hint: "Routine actions inside your grants run; a classifier asks on anything sensitive.",
  },
];

/** Security §3.9 / architecture §4.6: not configurable, shown read-only. */
export const HARD_PROHIBITIONS = [
  "Type a password, card number, bank account or government ID it can see",
  "Solve or bypass a CAPTCHA",
  "Make a financial transfer or trade",
  "Permanently delete data without a typed confirmation",
  "Follow instructions found in web pages, email or files",
  "Create third-party accounts without your approval",
  "Act on a localhost origin that isn't your own project",
  "Change permissions, grants, security settings or pairing from a tool call",
  "Read Safari or Passwords.app credentials",
  "Use a secret it can see, even one you paste",
] as const;

export const GRANT_KIND_LABEL: Partial<Record<Grant["kind"], string>> = {
  new_origin: "Website",
  connector_action: "Connector action",
  send_email: "Send email",
  calendar_write: "Calendar",
  exec: "Command",
  file_write: "File write",
  mcp_tool: "MCP tool",
  credential_fill: "Credential fill",
  computer_action: "Computer use",
};

const SCOPE_LABEL: Record<Grant["scope"], string> = {
  once: "once",
  task: "this task",
  site: "this site",
  session: "this session",
  always: "always",
};

/** One line naming exactly what a grant covers. */
export function grantSubject(g: Grant): string {
  const s = g.subject;
  const text = (k: string) => (typeof s[k] === "string" ? (s[k] as string) : null);
  if (g.kind === "new_origin")
    return `${(text("origin") ?? g.grantKey).replace(/^https?:\/\//, "")} (${text("access") ?? "r"})`;
  if (g.kind === "connector_action" || g.kind === "mcp_tool")
    return text("action") ?? text("tool") ?? g.grantKey;
  if (g.kind === "exec" && Array.isArray(s.argv))
    return `${(s.argv as unknown[]).join(" ")}${text("cwd") ? ` in ${text("cwd")}` : ""}`;
  if (g.kind === "send_email") return `to ${text("recipient") ?? "any recipient"}`;
  if (g.kind === "calendar_write") return `calendar ${text("calendarId") ?? ""}`.trim();
  return g.grantKey;
}

/** `lastSync.toolsListChanged` marks an MCP server whose tools/list hash changed. */
export function toolsListChanged(c: Connector): boolean {
  return c.type === "mcp" && c.lastSync?.toolsListChanged === true;
}

export interface PermissionsPanelProps extends SettingsFormProps, LoadProps {
  connectors: readonly Connector[];
  grants: readonly Grant[];
  folders: readonly FolderGrant[];
  now?: number;
  onRevoke?: (grant: Grant) => void;
  /** Per-connector matrix change; the connected screen writes `permissions.connectors.<id>`. */
  onRuleChange?: (connector: Connector, action: string, rule: ActionRule) => void;
  onOpenFiles?: () => void;
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
  folders,
  now,
  onRevoke,
  onRuleChange,
  onOpenFiles,
  revoking,
  revokeError = null,
  loading,
  error,
  onRetry,
}: PermissionsPanelProps): ReactElement {
  const clock = useNow(30_000, now);
  const [showProhibitions, setShowProhibitions] = useState(false);
  const mode = str(values, "permissions.mode", "balanced") as PermissionMode;
  const origins = grants.filter((g) => g.kind === "new_origin" && g.revokedAt === null);
  const active = grants.filter((g) => g.revokedAt === null);

  return (
    <SectionFrame
      needsApproval={needsApproval}
      title="Permissions"
      description="What runs on its own, what asks first and what never happens."
    >
      <LoadGate
        label="permissions"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title="Default mode for new threads">
          <RadioField
            label="Default mode"
            hideLabel
            inline
            value={mode}
            options={MODE_OPTIONS}
            settingKey="permissions.mode"
            onChange={(v) => onChange("permissions.mode", v)}
          ></RadioField>
        </Group>

        <Group
          title="Connector actions"
          description="Allow runs without asking, Ask shows an approval card, Deny never runs."
        >
          {connectors.length === 0 ? (
            <EmptyNotice text="No connectors yet, so there are no actions to set." />
          ) : (
            connectors.map((c) => {
              const changed = toolsListChanged(c);
              const key = `permissions.connectors.${c.id}`;
              const hash = c.config.toolsListHash;
              return (
                <div
                  key={c.id}
                  className="flex flex-col gap-1 border-t border-gray-6 pt-3 first:border-0 first:pt-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-semibold">
                      {c.label}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({SCOPE_MODE_LABEL[c.scopeMode].toLowerCase()})
                      </span>
                    </h4>
                    {c.type === "mcp" ? (
                      changed ? (
                        <StatusChip tone="danger">
                          <ShieldOff className="size-3" aria-hidden="true" /> Grants revoked
                        </StatusChip>
                      ) : (
                        <StatusChip tone="success">tools/list hash ok</StatusChip>
                      )
                    ) : null}
                  </div>
                  {changed ? (
                    <p className="text-xs text-danger-text">
                      {c.label} changed its tool list since you approved it, so Psyche revoked its
                      grants. Every action asks again until you review it.
                    </p>
                  ) : null}
                  {c.type === "mcp" && typeof hash === "string" ? (
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      tools/list {hash.slice(0, 19)}…
                    </p>
                  ) : null}
                  <ActionMatrix
                    connectorLabel={c.label}
                    matrix={c.actionMatrix}
                    onChange={(action, rule) => onRuleChange?.(c, action, rule)}
                    disabled={onRuleChange === undefined}
                  />
                  <SettingHint settingKey={key} />
                </div>
              );
            })
          )}
        </Group>

        <Group title="Browser origins" description="Sites the agent may open without asking.">
          {origins.length === 0 ? (
            <EmptyNotice text="No standing website grants. New sites ask first." />
          ) : (
            <ul className="flex flex-col gap-1.5">
              {origins.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{grantSubject(g)}</span>
                  <span className="text-xs text-muted-foreground">
                    {SCOPE_LABEL[g.scope]}
                    {g.expiresAt ? `, expires ${formatDate(g.expiresAt)}` : ""}
                  </span>
                  {onRevoke ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => onRevoke(g)}
                      disabled={revoking?.has(g.id) ?? false}
                      aria-label={`Revoke ${grantSubject(g)}`}
                    >
                      Revoke
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Group>

        <Group
          title="Folders"
          actions={
            onOpenFiles ? (
              <Button type="button" variant="outline" size="sm" onClick={onOpenFiles}>
                Edit in File access
              </Button>
            ) : null
          }
        >
          {folders.length === 0 ? (
            <p className="text-muted-foreground">No folders shared.</p>
          ) : (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {folders.map((f) => (
                <li key={f.path}>
                  <code className="font-mono text-xs">{f.path}</code>{" "}
                  <span className="text-xs text-muted-foreground">
                    {f.access === "rw" ? "read and write" : "read only"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Group>

        <Group
          title="Grants ledger"
          description={`${plural(active.length, "active grant")}. Revoking takes effect at once.`}
        >
          {revokeError ? <ErrorNotice what={revokeError} did="The grant is unchanged." /> : null}
          {grants.length === 0 ? (
            <EmptyNotice text="No grants yet. Choosing “Always allow” on an approval adds one here." />
          ) : (
            <Table aria-label="Grants ledger">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Grant</TableHead>
                  <TableHead scope="col">Scope</TableHead>
                  <TableHead scope="col">Uses</TableHead>
                  <TableHead scope="col">Last used</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((g) => (
                  <TableRow key={g.id} data-revoked={g.revokedAt !== null}>
                    <TableCell className="whitespace-normal">
                      <span className="block text-xs text-muted-foreground">
                        {GRANT_KIND_LABEL[g.kind] ?? g.kind}
                      </span>
                      <span className={g.revokedAt ? "text-muted-foreground line-through" : ""}>
                        {grantSubject(g)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {SCOPE_LABEL[g.scope]}
                      {g.expiresAt ? (
                        <span className="block text-xs text-muted-foreground">
                          {Date.parse(g.expiresAt) < clock
                            ? "expired"
                            : `until ${formatDate(g.expiresAt)}`}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{g.useCount}</TableCell>
                    <TableCell>
                      {g.lastUsedAt ? formatRelative(g.lastUsedAt, clock) : "never"}
                    </TableCell>
                    <TableCell className="text-right">
                      {g.revokedAt ? (
                        <StatusChip tone="neutral">Revoked</StatusChip>
                      ) : onRevoke ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          onClick={() => onRevoke(g)}
                          disabled={revoking?.has(g.id) ?? false}
                          aria-label={`Revoke ${grantSubject(g)}`}
                        >
                          Revoke
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Group>

        <Group
          title="Hard prohibitions"
          description="These never happen, in any mode. They can't be changed."
          actions={
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={showProhibitions}
              aria-controls="psyche-hard-prohibitions"
              onClick={() => setShowProhibitions((v) => !v)}
            >
              {showProhibitions ? "Hide" : "Show"}
            </Button>
          }
        >
          {showProhibitions ? (
            <ul id="psyche-hard-prohibitions" className="list-disc pl-5 text-gray-11">
              {HARD_PROHIBITIONS.map((p) => (
                <li key={p}>{p}</li>
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

function isRule(v: unknown): v is ActionRule {
  return v === "allow" || v === "ask" || v === "deny";
}

/** Applies `permissions.connectors.<id>` overrides from settings to each connector's matrix. */
export function withMatrixOverrides(
  connectors: readonly Connector[],
  values: Readonly<Record<string, unknown>>,
): Connector[] {
  return connectors.map((c) => {
    const o = values[`permissions.connectors.${c.id}`];
    if (typeof o !== "object" || o === null) return c;
    const matrix = { ...c.actionMatrix };
    for (const [k, v] of Object.entries(o)) if (isRule(v)) matrix[k] = v;
    return { ...c, actionMatrix: matrix };
  });
}

export function PermissionsSection({ now }: { now?: number }): ReactElement {
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
            setRevokeError(`Psyche couldn't revoke “${grantSubject(g)}” (${messageOf(err)}).`),
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
        folders={folderGrants(form.values)}
        onRevoke={onRevoke}
        onRuleChange={(c, action, rule) =>
          form.onChange(`permissions.connectors.${c.id}`, { ...c.actionMatrix, [action]: rule })
        }
        onOpenFiles={() => navigate?.("/settings/files")}
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
