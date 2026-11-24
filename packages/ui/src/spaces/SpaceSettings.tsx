import type { PermissionMode, SpaceDetail } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Label } from "../components/ui/label.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { useCall, useGatewayQuery } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { describeError } from "../i18n/errors.ts";
import { ScreenSection } from "../screens/feed/ScreenToolbar.tsx";
import { AdminHint, hasCode } from "../screens/settings/shared.tsx";

/**
 * Space settings (docs/design/spaces-2026.md §4.2, SP8): the three things `spaces.settings.set`
 * accepts. The Gateway holds the rules (admin scope, "on your computer" for widening an
 * automation's file access, the mode capped by the global setting, the connector scope that only
 * narrows); this section only asks, and shows its refusals. A client of another computer's
 * Gateway, or a window with no folder picker, sees the values and the reason it cannot change them.
 */

const MODES: readonly PermissionMode[] = ["plan", "manual", "balanced", "auto"];

/** Literal catalogue ids, so the key scan finds them. */
const MODE_LABEL: Record<PermissionMode, () => string> = {
  plan: () => t("spaces.settings.mode.plan"),
  manual: () => t("spaces.settings.mode.manual"),
  balanced: () => t("spaces.settings.mode.balanced"),
  auto: () => t("spaces.settings.mode.auto"),
};
const MODE_HINT: Record<PermissionMode | "inherit", () => string> = {
  inherit: () => t("spaces.settings.mode.inheritHint"),
  plan: () => t("spaces.settings.mode.planHint"),
  manual: () => t("spaces.settings.mode.manualHint"),
  balanced: () => t("spaces.settings.mode.balancedHint"),
  auto: () => t("spaces.settings.mode.autoHint"),
};

const isMode = (v: string): v is PermissionMode => (MODES as readonly string[]).includes(v);

export interface SpaceSettingsSectionProps {
  detail: SpaceDetail;
  /** Why the settings cannot be changed from this window (shown as a note); null when they can. */
  readOnlyReason: string | null;
  /** The Space is archived: the same quiet lock the folder controls get. */
  archived: boolean;
  onSaved: () => void;
}

export function SpaceSettingsSection({
  detail,
  readOnlyReason,
  archived,
  onSaved,
}: SpaceSettingsSectionProps): ReactElement {
  const call = useCall();
  const ids = useId();
  const connectors = useGatewayQuery("connectors.list", {});
  // The scope names connectors and MCP servers alike (they share one namespace at run time).
  const servers = useGatewayQuery("mcp.status", {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAdmin, setNeedsAdmin] = useState(false);
  const { space } = detail;
  const spaceId = space.id;
  const locked = readOnlyReason !== null || archived || needsAdmin || busy;

  const save = (
    params: Partial<{
      defaultPermissionMode: PermissionMode | null;
      connectorScope: string[] | null;
      automationsWrite: { path: string; allow: boolean }[];
    }>,
  ) => {
    setBusy(true);
    setError(null);
    call("spaces.settings.set", { spaceId, ...params }).then(
      () => {
        setBusy(false);
        onSaved();
      },
      (err: unknown) => {
        setBusy(false);
        // `forbidden` for want of admin on this device; the Mac-only refusal says so itself.
        const reason = (err as { details?: { reason?: unknown } }).details?.reason;
        if (hasCode(err, "forbidden") && reason !== "host_only") setNeedsAdmin(true);
        else setError(describeError(err));
      },
    );
  };

  const mode: PermissionMode | "inherit" = space.defaultPermissionMode ?? "inherit";
  const scope = space.connectorScope;
  const known = connectors.data?.connectors ?? [];
  const knownServers = servers.data?.servers ?? [];
  // "Only the ones I choose" starts from both lists: saving before both loaded would drop the rest.
  const listsLoaded = connectors.data !== undefined && servers.data !== undefined;
  const toggleConnector = (id: string, on: boolean) => {
    const current = scope ?? [];
    save({
      connectorScope: on
        ? [...current.filter((c) => c !== id), id]
        : current.filter((c) => c !== id),
    });
  };

  return (
    <ScreenSection
      id="settings"
      title={t("spaces.settings.title")}
      description={t("spaces.settings.description")}
    >
      <div className="flex flex-col gap-5 px-2.5" data-testid="space-settings">
        {readOnlyReason !== null ? (
          <p role="note" className="text-callout text-label-secondary">
            {readOnlyReason}
          </p>
        ) : null}
        <AdminHint show={needsAdmin} />

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-mode`}>{t("spaces.settings.mode.label")}</Label>
          <NativeSelect
            id={`${ids}-mode`}
            size="sm"
            value={mode}
            disabled={locked}
            aria-describedby={`${ids}-mode-hint`}
            onChange={(e) =>
              save({ defaultPermissionMode: isMode(e.target.value) ? e.target.value : null })
            }
          >
            <option value="inherit">{t("spaces.settings.mode.inherit")}</option>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]()}
              </option>
            ))}
          </NativeSelect>
          <p id={`${ids}-mode-hint`} className="text-callout text-label-secondary">
            {MODE_HINT[mode]()} {t("spaces.settings.mode.ceiling")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${ids}-scope`}>{t("spaces.settings.connectors.label")}</Label>
          <NativeSelect
            id={`${ids}-scope`}
            size="sm"
            value={scope === null ? "all" : "some"}
            disabled={locked}
            aria-describedby={`${ids}-scope-hint`}
            onChange={(e) =>
              save({
                connectorScope:
                  e.target.value === "all"
                    ? null
                    : [...known.map((c) => c.id), ...knownServers.map((x) => x.id)],
              })
            }
          >
            <option value="all">{t("spaces.settings.connectors.all")}</option>
            <option value="some" disabled={!listsLoaded && scope === null}>
              {t("spaces.settings.connectors.some")}
            </option>
          </NativeSelect>
          <p id={`${ids}-scope-hint`} className="text-callout text-label-secondary">
            {scope === null
              ? t("spaces.settings.connectors.allHint")
              : t("spaces.settings.connectors.someHint")}
          </p>
          {scope !== null ? (
            known.length === 0 && knownServers.length === 0 ? (
              <p className="text-callout text-label-secondary">
                {t("spaces.settings.connectors.none")}
              </p>
            ) : (
              <>
                {known.length > 0 ? (
                  <ScopeList heading={t("spaces.settings.connectors.groupConnectors")}>
                    {known.map((c) => (
                      <ScopeRow
                        key={c.id}
                        label={c.label}
                        detail={c.account}
                        aria={t("spaces.settings.connectors.use", { name: c.label })}
                        checked={scope?.includes(c.id) === true}
                        disabled={locked}
                        onChange={(on) => toggleConnector(c.id, on)}
                      />
                    ))}
                  </ScopeList>
                ) : null}
                {knownServers.length > 0 ? (
                  <ScopeList heading={t("spaces.settings.connectors.groupServers")}>
                    {knownServers.map((x) => (
                      <ScopeRow
                        key={x.id}
                        label={x.name}
                        detail={null}
                        aria={t("spaces.settings.connectors.use", { name: x.name })}
                        checked={scope?.includes(x.id) === true}
                        disabled={locked}
                        onChange={(on) => toggleConnector(x.id, on)}
                      />
                    ))}
                  </ScopeList>
                ) : null}
              </>
            )
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-body text-label-primary">{t("spaces.settings.automations")}</span>
          <p className="text-callout text-label-secondary">
            {t("spaces.settings.automationsHint")}
          </p>
          {detail.folders.length === 0 ? (
            <p className="text-callout text-label-secondary">
              {t("spaces.settings.automationsNone")}
            </p>
          ) : (
            <ul className="flex flex-col">
              {detail.folders.map((f) => (
                <li key={f.path} className="flex min-h-8 items-center gap-2">
                  <Checkbox
                    aria-label={t("spaces.settings.automationsIn", { path: f.path })}
                    checked={f.automationsWrite}
                    disabled={locked || (f.mode === "ro" && !f.automationsWrite)}
                    onCheckedChange={(on) =>
                      save({ automationsWrite: [{ path: f.path, allow: on === true }] })
                    }
                  />
                  <span className="min-w-0 truncate font-mono text-callout text-label-primary">
                    {f.path}
                  </span>
                  {f.mode === "ro" && !f.automationsWrite ? (
                    <span className="text-callout text-label-secondary">
                      {t("spaces.settings.automationsNeedsRw")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        {error ? (
          <p role="alert" className="text-callout text-danger-text">
            {t("spaces.settings.failed", { reason: error })}
          </p>
        ) : null}
      </div>
    </ScreenSection>
  );
}

function ScopeList({ heading, children }: { heading: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex flex-col">
      <span className="text-callout text-label-secondary">{heading}</span>
      <ul className="flex flex-col">{children}</ul>
    </div>
  );
}

function ScopeRow(props: {
  label: string;
  detail: string | null;
  aria: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}): ReactElement {
  return (
    <li className="flex min-h-8 items-center gap-2">
      <Checkbox
        aria-label={props.aria}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(on) => props.onChange(on === true)}
      />
      <span className="min-w-0 truncate text-body text-label-primary">
        {props.label}
        {props.detail ? <span className="text-label-secondary"> · {props.detail}</span> : null}
      </span>
    </li>
  );
}
