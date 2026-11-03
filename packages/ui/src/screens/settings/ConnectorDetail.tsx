import type { Connector, ConnectorCatalogueEntry } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.tsx";
import { Button } from "../../components/ui/button.tsx";
import { t } from "../../i18n/core.ts";
import { formatRelative } from "../../lib/format.ts";
import type { ActionRule } from "./ActionMatrix.tsx";
import { CapabilityCard } from "./ConnectorCapabilities.tsx";
import { Disclosure, FactRows } from "./ConnectorRow.tsx";
import { ConnectedShortcutsCard, ObsidianCard } from "./ConnectorSettingsCards.tsx";
import { type ConnectorPermission, PermissionNotice, permissionOf } from "./connect-flow.tsx";
import { SCOPE_MODE_LABEL } from "./connector-catalog.tsx";
import { Facts, Group } from "./shared.tsx";
import { ConnectedTrustedSourcesCard, trustedAppOf } from "./TrustedSourcesCard.tsx";

/**
 * A connected account's detail: what is wrong (if anything) and the one button that fixes it,
 * what it is, what the persona can do with it, its own settings, and the buttons that pause or
 * remove it. Scopes and ids sit one level down under Technical details.
 */

/** The trust tier of a connector: MCP ones carry one in config, built-in ones are first-party. */
export function trustTier(c: Connector): string {
  const tier = c.config.trustTier;
  if (typeof tier === "string") return tier;
  return c.type === "mcp" ? "unverified" : "built-in";
}

function sourceLabel(tier: string): string {
  if (tier === "built-in") return t("settings.connectors.page.source.builtIn");
  if (tier === "verified") return t("settings.connectors.page.source.verified");
  if (tier === "unverified") return t("settings.connectors.page.source.unverified");
  return tier;
}

/** When a connector was last used, or null if never. */
export function lastUsed(c: Connector): string | null {
  const at = c.lastSync?.at;
  return typeof at === "string" ? at : null;
}

/** The reason a failing connector gave, if it left one (`lastSync.error`). */
function failureReason(c: Connector): string | null {
  const e = c.lastSync?.error;
  return typeof e === "string" && e !== "" ? e : null;
}

/** A button that asks before it removes: the destructive action lives in the detail, not the row. */
function RemoveButton({ name, onConfirm }: { name: string; onConfirm: () => void }): ReactElement {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button type="button" variant="destructive" size="sm" onClick={() => setAsking(true)}>
        {t("common.remove")}
      </Button>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.connectors.removeTitle", { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.connectors.removeDescription", { name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                setAsking(false);
                onConfirm();
              }}
            >
              {t("common.remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The amber note at the top of a detail that needs the owner. */
function Attention({ children }: { children: ReactNode }): ReactElement {
  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-lg border border-approval-border bg-approval-surface p-3 text-body text-approval-text"
    >
      {children}
    </div>
  );
}

export function ConnectorDetail({
  connector: c,
  persona,
  now,
  actions,
  lifted,
  sharedFolders,
  onReconnect,
  onDisconnect,
  onRemove,
  removable,
  onGrant,
  onCheck,
  onRuleChange,
  onTry,
  onShareFolder,
  onConfigure,
  defaultCapabilitiesOpen,
}: {
  connector: Connector;
  persona: string;
  now: number;
  actions: ConnectorCatalogueEntry["actions"];
  lifted: readonly string[];
  sharedFolders: readonly string[];
  onReconnect?: (c: Connector) => void;
  onDisconnect?: (c: Connector) => void;
  onRemove?: (c: Connector) => void;
  removable?: (c: Connector) => boolean;
  onGrant?: (c: Connector) => void;
  onCheck?: (c: Connector) => void;
  onRuleChange?: (c: Connector, action: string, rule: ActionRule, liftFloor?: boolean) => void;
  onTry?: (text: string) => void;
  onShareFolder?: (path: string, mode: Connector["scopeMode"]) => void;
  onConfigure?: (c: Connector, config: Record<string, unknown>) => void;
  defaultCapabilitiesOpen?: boolean;
}): ReactElement {
  const permission: ConnectorPermission | null = permissionOf(c);
  const used = lastUsed(c);
  const reason = failureReason(c);
  const configure = onConfigure
    ? (config: Record<string, unknown>) => onConfigure(c, config)
    : undefined;
  const canRemove = onRemove !== undefined && (removable?.(c) ?? true);
  return (
    <div className="flex flex-col gap-4">
      {permission && c.status === "needs_auth" ? (
        <Attention>
          <PermissionNotice name={c.label} permission={permission} />
          <div className="flex gap-2">
            {onGrant && permission.state === "denied" ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onGrant(c)}>
                {t("settings.connect.openSystemSettings")}
              </Button>
            ) : null}
            {onCheck ? (
              <Button type="button" size="sm" variant="outline" onClick={() => onCheck(c)}>
                {t("settings.connect.checkAgain")}
              </Button>
            ) : null}
          </div>
        </Attention>
      ) : c.status === "needs_auth" ? (
        <Attention>
          <p>{t("settings.connectors.page.attention.signIn", { name: c.label })}</p>
          {onReconnect ? (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => onReconnect(c)}>
                {t("settings.connectors.status.needs_auth")}
              </Button>
            </div>
          ) : null}
        </Attention>
      ) : c.status === "error" ? (
        <Attention>
          <p>{t("settings.connectors.page.attention.error", { name: c.label })}</p>
          {reason ? (
            <p className="text-callout">
              {t("settings.connectors.page.attention.errorReason", { reason })}
            </p>
          ) : null}
          {onReconnect ? (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => onReconnect(c)}>
                {t("settings.connectors.status.needs_auth")}
              </Button>
            </div>
          ) : null}
        </Attention>
      ) : null}
      <Group title={t("settings.connectors.page.detail.about")}>
        <FactRows
          items={[
            {
              term: t("settings.connectors.account"),
              value: c.account ?? t("settings.connectors.noAccount"),
            },
            {
              term: t("settings.connectors.page.detail.access"),
              value: SCOPE_MODE_LABEL[c.scopeMode],
            },
            {
              term: t("settings.credentials.col.lastUsed"),
              value:
                used === null ? t("settings.connectors.page.row.never") : formatRelative(used, now),
            },
            {
              term: t("settings.connectors.page.detail.source"),
              value: sourceLabel(trustTier(c)),
            },
          ]}
        />
      </Group>
      <CapabilityCard
        connector={c}
        actions={actions}
        persona={persona}
        lifted={lifted}
        bare
        {...(onRuleChange
          ? {
              onRuleChange: (action: string, rule: ActionRule, lift?: boolean) =>
                onRuleChange(c, action, rule, lift),
            }
          : {})}
        {...(onTry ? { onTry } : {})}
        {...(defaultCapabilitiesOpen ? { defaultOpen: true } : {})}
      />
      {c.type === "apple:shortcuts" && c.status === "connected" ? (
        <ConnectedShortcutsCard connector={c} {...(configure ? { onConfigure: configure } : {})} />
      ) : null}
      {trustedAppOf(c.type) !== null && c.status === "connected" ? (
        <ConnectedTrustedSourcesCard
          connector={c}
          app={trustedAppOf(c.type) ?? "reminders"}
          {...(configure ? { onConfigure: configure } : {})}
        />
      ) : null}
      {c.type === "obsidian" ? (
        <ObsidianCard
          connector={c}
          granted={sharedFolders}
          {...(onShareFolder
            ? { onShare: (path: string) => onShareFolder(path, c.scopeMode) }
            : {})}
          {...(configure ? { onConfigure: configure } : {})}
        />
      ) : null}
      <Disclosure label={t("settings.connectors.page.detail.technical")}>
        <Facts
          className="text-callout"
          items={[
            { term: t("settings.connectors.page.detail.type"), value: <code>{c.type}</code> },
            {
              term: t("settings.connectors.scopes"),
              value:
                c.scopes.length === 0 ? (
                  t("settings.connectors.noAccount")
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {c.scopes.map((sc) => (
                      <code
                        key={sc}
                        className="rounded-xs bg-fill-tertiary px-1 font-mono text-mono"
                      >
                        {sc}
                      </code>
                    ))}
                  </span>
                ),
            },
          ]}
        />
      </Disclosure>
      {onDisconnect || canRemove ? (
        <Group
          title={t("settings.connectors.page.detail.manage")}
          description={t("settings.connectors.page.detail.removeHint")}
        >
          <div className="flex flex-wrap items-center gap-2">
            {onDisconnect && c.status !== "disconnected" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onDisconnect(c)}
                aria-label={t("settings.connectors.disconnectNamed", { name: c.label })}
              >
                {t("settings.connectors.disconnect")}
              </Button>
            ) : null}
            {canRemove && onRemove ? (
              <RemoveButton name={c.label} onConfirm={() => onRemove(c)} />
            ) : null}
          </div>
        </Group>
      ) : null}
    </div>
  );
}
