import type { AppleShortcut, Connector } from "@psyche/protocol";
import { FolderCheck } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useId, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { useSlots } from "../../slots.tsx";
import { SegmentedRadio } from "./SegmentedRadio.tsx";
import { GROUP_ROWS, StatusChip } from "./shared.tsx";

/**
 * Settings → Connectors cards with their own settings (docs/connectors/apple-apps-2026.md §7.1,
 * #640): Shortcuts (the owner's shortcuts, each off / ask / allow, and the Psyche Actions to
 * install) and Obsidian (the vault, chosen through File access, and the daily-note folder). Both
 * save through `connectors.configure`.
 */

// --- Shortcuts -------------------------------------------------------------------------------------

/** What a shortcut may do: off refuses it, ask shows a card, allow runs it (read-only ones). */
export type ShortcutRule = "off" | "ask" | "allow";

const shortcutRule = (value: ShortcutRule) => ({
  value,
  get label(): string {
    return t(`settings.shortcuts.rule.${value}`);
  },
});
const SHORTCUT_RULES = [shortcutRule("off"), shortcutRule("ask"), shortcutRule("allow")];

/** `config.shortcutRules` of an `apple:shortcuts` connector; a shortcut without one asks. */
export function shortcutRules(c: Connector): Record<string, ShortcutRule> {
  const raw = c.config.shortcutRules;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, ShortcutRule> = {};
  for (const [id, v] of Object.entries(raw))
    if (v === "off" || v === "ask" || v === "allow") out[id] = v;
  return out;
}

/** A shortcut Psyche ships for an intent-only feature (K3), installed once from Settings. */
export interface PsycheAction {
  id: string;
  name: string;
  installUrl: string;
}

/** Psyche Actions arrive with wave 2 as a catalogue list; none ship yet, so the section hides. */
export const PSYCHE_ACTIONS: readonly PsycheAction[] = [];

export interface ShortcutsCardProps {
  connector: Connector;
  shortcuts: readonly AppleShortcut[] | null;
  loading?: boolean;
  /** Why the list could not be read (no helper, an error). */
  error?: string | null;
  onRuleChange?: (shortcutId: string, rule: ShortcutRule) => void;
  psycheActions?: readonly PsycheAction[];
  onInstall?: (action: PsycheAction) => void;
}

export function ShortcutsCard({
  connector,
  shortcuts,
  loading = false,
  error = null,
  onRuleChange,
  psycheActions = PSYCHE_ACTIONS,
  onInstall,
}: ShortcutsCardProps): ReactElement {
  const id = useId();
  const rules = shortcutRules(connector);
  const names = new Set((shortcuts ?? []).map((s) => s.name));
  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-list`} className="text-callout text-label-secondary">
        {t("settings.shortcuts.title")}
      </span>
      {error ? (
        <p role="status" className="text-callout text-label-secondary">
          {error}
        </p>
      ) : loading || shortcuts === null ? (
        <p className="text-callout text-label-tertiary">{t("settings.shortcuts.loading")}</p>
      ) : shortcuts.length === 0 ? (
        <p className="text-callout text-label-tertiary">{t("settings.shortcuts.none")}</p>
      ) : (
        <ul aria-labelledby={`${id}-list`} className={GROUP_ROWS}>
          {shortcuts.map((s) => {
            const rule = rules[s.id] ?? "ask";
            return (
              <li key={s.id} data-rule={rule} className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body text-label-primary">{s.name}</span>
                  {s.folder ? (
                    <span className="text-callout text-label-secondary">{s.folder}</span>
                  ) : null}
                </div>
                <SegmentedRadio
                  label={s.name}
                  options={SHORTCUT_RULES}
                  value={rule}
                  disabled={onRuleChange === undefined}
                  onChange={(next) => onRuleChange?.(s.id, next)}
                  segmentLabel={(o) => t("settings.matrix.cell", { row: s.name, column: o.label })}
                />
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-callout text-label-tertiary">{t("settings.shortcuts.hint")}</p>
      {psycheActions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <span id={`${id}-actions`} className="text-callout text-label-secondary">
            {t("settings.shortcuts.actions")}
          </span>
          <ul aria-labelledby={`${id}-actions`} className={GROUP_ROWS}>
            {psycheActions.map((a) => {
              const installed = names.has(a.name);
              return (
                <li key={a.id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-body text-label-primary">{a.name}</span>
                  {installed ? (
                    <StatusChip tone="success">{t("settings.shortcuts.installed")}</StatusChip>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={onInstall === undefined}
                      onClick={() => onInstall?.(a)}
                      aria-label={t("settings.shortcuts.installNamed", { name: a.name })}
                    >
                      {t("settings.shortcuts.install")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function shortcutsOf(result: unknown): AppleShortcut[] {
  const list = (result as { shortcuts?: unknown } | undefined)?.shortcuts;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s): s is AppleShortcut =>
      typeof s === "object" &&
      s !== null &&
      typeof (s as AppleShortcut).id === "string" &&
      typeof (s as AppleShortcut).name === "string",
  );
}

/** The owner's shortcuts, read from the paired helper (`nodes.invoke` → `shortcuts.list`, K1). */
export function useHelperShortcuts(enabled: boolean): {
  shortcuts: AppleShortcut[] | null;
  loading: boolean;
  error: string | null;
} {
  const call = useCall();
  const nodes = useGatewayQuery("nodes.list", {}, { enabled });
  const helper = nodes.data?.nodes.find((n) => n.kind === "mac-helper" && n.status === "online");
  const [state, setState] = useState<{ shortcuts: AppleShortcut[] | null; error: string | null }>({
    shortcuts: null,
    error: null,
  });
  const helperId = helper?.id ?? null;
  const load = useCallback(
    (nodeId: string) =>
      call("nodes.invoke", { nodeId, capability: "shortcuts.list", params: {} }).then(
        (r) =>
          r.ok
            ? setState({ shortcuts: shortcutsOf(r.result), error: null })
            : setState({
                shortcuts: null,
                error: r.error ? describeError(r.error) : t("settings.shortcuts.failed"),
              }),
        (err: unknown) => setState({ shortcuts: null, error: describeError(err) }),
      ),
    [call],
  );
  useEffect(() => {
    if (enabled && helperId !== null) void load(helperId);
  }, [enabled, helperId, load]);
  if (!enabled) return { shortcuts: null, loading: false, error: null };
  if (nodes.data !== undefined && helperId === null)
    return { shortcuts: null, loading: false, error: t("settings.shortcuts.noHelper") };
  return { ...state, loading: state.shortcuts === null && state.error === null };
}

/** The Shortcuts card with its list read from the helper and its rules saved on the connector. */
export function ConnectedShortcutsCard({
  connector,
  onConfigure,
}: {
  connector: Connector;
  onConfigure?: (config: Record<string, unknown>) => void;
}): ReactElement {
  const { openExternal } = useSlots();
  const list = useHelperShortcuts(connector.status === "connected");
  return (
    <ShortcutsCard
      connector={connector}
      shortcuts={list.shortcuts}
      loading={list.loading}
      error={list.error}
      {...(onConfigure
        ? {
            onRuleChange: (id: string, rule: ShortcutRule) =>
              onConfigure({ shortcutRules: { ...shortcutRules(connector), [id]: rule } }),
          }
        : {})}
      {...(openExternal ? { onInstall: (a: PsycheAction) => void openExternal(a.installUrl) } : {})}
    />
  );
}

// --- Obsidian --------------------------------------------------------------------------------------

/**
 * Choosing a vault through File access: the folder is shared first (a folder grant, read-only or
 * read-and-write by the connector's mode), then used. `granted` lists the shared folder paths.
 */
export function VaultField({
  value,
  onChange,
  granted,
  onShare,
  label,
}: {
  value: string;
  onChange: (path: string) => void;
  granted: readonly string[];
  onShare?: (path: string) => void;
  label?: string;
}): ReactElement {
  const id = useId();
  const path = value.trim();
  const shared = path !== "" && granted.includes(path);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${id}-vault`} className="text-body text-label-primary">
        {label ?? t("settings.obsidian.vault")}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${id}-vault`}
          className="min-w-64 flex-1 font-mono"
          // i18n-ignore: an example path
          placeholder="~/Documents/Obsidian Vault"
          value={value}
          aria-describedby={`${id}-vault-hint`}
          onChange={(e) => onChange(e.target.value)}
        />
        {shared ? (
          <StatusChip tone="success">
            <FolderCheck aria-hidden="true" className="size-3.5" /> {t("settings.obsidian.shared")}
          </StatusChip>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={path === "" || onShare === undefined}
            onClick={() => onShare?.(path)}
          >
            {t("settings.obsidian.share")}
          </Button>
        )}
      </div>
      <p id={`${id}-vault-hint`} className="text-callout text-label-secondary">
        {t("settings.obsidian.vaultHint")}
      </p>
    </div>
  );
}

export interface ObsidianCardProps {
  connector: Connector;
  /** Shared folders (`permissions.policy.folders`). */
  granted: readonly string[];
  onShare?: (path: string) => void;
  onConfigure?: (config: Record<string, unknown>) => void;
}

/** The connected vault: its path and daily-note folder, and changing the vault. */
export function ObsidianCard({
  connector,
  granted,
  onShare,
  onConfigure,
}: ObsidianCardProps): ReactElement {
  const id = useId();
  const vault = typeof connector.config.vaultPath === "string" ? connector.config.vaultPath : "";
  const daily =
    typeof connector.config.dailyFolder === "string" ? connector.config.dailyFolder : "";
  const [dailyDraft, setDailyDraft] = useState(daily);
  useEffect(() => setDailyDraft(daily), [daily]);
  const [changing, setChanging] = useState(false);
  const [next, setNext] = useState("");
  const saveDaily = () => {
    const v = dailyDraft.trim();
    if (v !== daily) onConfigure?.({ dailyFolder: v === "" ? null : v });
  };
  const nextPath = next.trim();
  return (
    <div className="flex flex-col gap-2">
      <dl className="flex flex-col gap-1 text-callout">
        <div className="flex flex-wrap gap-x-2">
          <dt className="text-label-secondary">{t("settings.obsidian.vault")}</dt>
          <dd className="font-mono text-mono text-label-primary">
            {vault || t("settings.obsidian.noVault")}
          </dd>
        </div>
      </dl>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-daily`} className="text-body text-label-primary">
          {t("settings.obsidian.daily")}
        </label>
        <Input
          id={`${id}-daily`}
          className="max-w-xs font-mono"
          value={dailyDraft}
          placeholder={t("settings.obsidian.dailyPlaceholder")}
          disabled={onConfigure === undefined}
          onChange={(e) => setDailyDraft(e.target.value)}
          onBlur={saveDaily}
          onKeyDown={(e) => {
            if (e.key === "Enter") saveDaily();
          }}
        />
      </div>
      {changing ? (
        <div className="flex flex-col gap-2">
          <VaultField
            value={next}
            onChange={setNext}
            granted={granted}
            {...(onShare ? { onShare } : {})}
            label={t("settings.obsidian.newVault")}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!granted.includes(nextPath) || onConfigure === undefined}
              onClick={() => {
                onConfigure?.({ vaultPath: nextPath });
                setChanging(false);
                setNext("");
              }}
            >
              {t("settings.obsidian.useVault")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setChanging(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={onConfigure === undefined}
            onClick={() => setChanging(true)}
          >
            {t("settings.obsidian.change")}
          </Button>
        </div>
      )}
    </div>
  );
}
