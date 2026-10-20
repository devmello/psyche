import type {
  EndpointProbe,
  ModelCapabilityGuess,
  ModelProviderSummary,
  ToolCheckStatus,
} from "@psyche/protocol";
import { KeyRound, Loader, Server } from "lucide-react";
import { type ReactElement, useCallback, useId, useRef, useState } from "react";
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
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { ContextSettingsGroup } from "./ContextSettings.tsx";
import {
  EmptyNotice,
  ErrorNotice,
  Group,
  hasCode,
  LoadGate,
  type LoadProps,
  messageOf,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  StatusChip,
  str,
  useSettingsForm,
} from "./shared.tsx";
import type { ProviderInfo, ProviderKind, ToolCheck } from "./types.ts";

/** Model & providers (UI design §3.18; architecture §4.4). */

const kindLabel = (k: ProviderKind): string => t(`settings.model.kind.${k}`);

const STATUS_TONE: Record<ProviderInfo["status"], "success" | "danger" | "neutral"> = {
  ok: "success",
  missing: "neutral",
  invalid: "danger",
  offline: "danger",
  unknown: "neutral",
  signed_out: "danger",
};

export function ToolCheckBadge({ status }: { status: ToolCheck }): ReactElement {
  switch (status) {
    case "passed":
      return <StatusChip tone="success">{t("settings.model.toolCheck.passed")}</StatusChip>;
    case "failed":
      return <StatusChip tone="approval">{t("settings.model.toolCheck.failed")}</StatusChip>;
    case "running":
      return (
        <StatusChip tone="info">
          <Loader className="size-3 motion-safe:animate-spin" aria-hidden="true" />
          {t("settings.model.toolCheck.running")}
        </StatusChip>
      );
    case "untested":
      return <StatusChip tone="neutral">{t("settings.model.toolCheck.untested")}</StatusChip>;
  }
}

const PROBE_TONE: Record<EndpointProbe["state"], "success" | "danger" | "neutral"> = {
  not_probed: "neutral",
  reachable: "success",
  unreachable: "danger",
  auth_failed: "danger",
  error: "danger",
};

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000)
    return t("settings.model.contextM", { n: Math.round(tokens / 100_000) / 10 });
  return t("settings.model.contextK", { n: Math.round(tokens / 1024) });
}

/** What a model can probably do, as text chips (B4). Unknown flags show nothing. */
export function CapabilityChips({
  capabilities,
}: {
  capabilities: ModelCapabilityGuess | undefined;
}): ReactElement | null {
  if (capabilities === undefined) return null;
  const chips: string[] = [];
  if (capabilities.embeddings === true) chips.push(t("settings.model.cap.embeddings"));
  if (capabilities.toolCalling === true) chips.push(t("settings.model.cap.tools"));
  if (capabilities.toolCalling === false && capabilities.embeddings !== true)
    chips.push(t("settings.model.cap.noTools"));
  if (capabilities.vision === true) chips.push(t("settings.model.cap.vision"));
  if (capabilities.reasoning === true) chips.push(t("settings.model.cap.reasoning"));
  if (capabilities.contextWindow !== undefined)
    chips.push(contextLabel(capabilities.contextWindow));
  if (chips.length === 0) return null;
  const guessed = capabilities.source === "heuristic";
  return (
    <span className="flex flex-wrap items-center gap-1">
      {chips.map((c) => (
        <StatusChip key={c} tone="neutral">
          {c}
        </StatusChip>
      ))}
      {guessed ? (
        <span className="text-xs text-muted-foreground">{t("settings.model.cap.guessed")}</span>
      ) : null}
    </span>
  );
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : activeI18n().dateTime(d, { dateStyle: "medium", timeStyle: "short" });
}

/** The last endpoint probe of one provider, and the button that runs another. */
export function EndpointProbeStatus({
  label,
  probe,
  probing,
  onProbe,
}: {
  label: string;
  probe: EndpointProbe;
  probing?: boolean;
  onProbe?: () => void;
}): ReactElement {
  const detail = [
    probe.state === "reachable"
      ? t("settings.model.probe.models", { n: probe.models.length })
      : null,
    probe.server ?? null,
    probe.latencyMs === undefined ? null : t("settings.model.probe.ms", { n: probe.latencyMs }),
    probe.probedAt === undefined
      ? null
      : t("settings.model.probe.checked", { when: timeOf(probe.probedAt) }),
  ].filter((x): x is string => x !== null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Server className="size-3.5" aria-hidden="true" />
        {probing === true ? (
          <StatusChip tone="info">
            <Loader className="size-3 motion-safe:animate-spin" aria-hidden="true" />
            {t("settings.model.probe.checking")}
          </StatusChip>
        ) : (
          <StatusChip tone={PROBE_TONE[probe.state]}>
            {t(`settings.model.probe.state.${probe.state}`)}
          </StatusChip>
        )}
        {detail.length > 0 ? <span>{detail.join(" · ")}</span> : null}
        {onProbe && probing !== true ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={onProbe}
            aria-label={t("settings.model.probe.checkNamed", { name: label })}
          >
            {probe.state === "not_probed"
              ? t("settings.model.probe.check")
              : t("settings.model.checkAgain")}
          </Button>
        ) : null}
      </div>
      {probe.error !== undefined && probe.state !== "reachable" ? (
        <p className="text-xs text-danger-text">{probe.error}</p>
      ) : null}
    </div>
  );
}

/** RAM tiers for local models (architecture §4.4). */
const ramTier = <G extends 16 | 32 | 96>(minGb: G) => ({
  minGb,
  get label(): string {
    return t(`settings.model.ram.${minGb as 16 | 32 | 96}.label`);
  },
  /** What fits, with model names as written by their makers. */
  get fits(): string {
    return t(`settings.model.ram.${minGb as 16 | 32 | 96}.fits`);
  },
});

export const RAM_TIERS = [ramTier(16), ramTier(32), ramTier(96)] as const;

export function RamGuidance({ ramGb }: { ramGb?: number }): ReactElement {
  const match =
    ramGb === undefined ? null : ([...RAM_TIERS].reverse().find((x) => ramGb >= x.minGb) ?? null);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground">
        {ramGb === undefined
          ? t("settings.model.ram.intro")
          : match === null
            ? t("settings.model.ram.tooSmall", { gb: ramGb, min: RAM_TIERS[0].minGb })
            : t("settings.model.ram.fits", { gb: ramGb, fits: match.fits })}
      </p>
      <ul className="grid gap-1">
        {RAM_TIERS.map((x) => (
          <li
            key={x.minGb}
            className={cn(
              "flex gap-2 rounded-md px-2 py-1",
              match?.minGb === x.minGb ? "bg-accent-3 text-accent-12" : "text-gray-11",
            )}
          >
            <span className="w-20 shrink-0 font-medium">{x.label}</span>
            <span>
              {x.fits}
              {match?.minGb === x.minGb ? (
                <span className="sr-only">{t("settings.model.ram.thisMac")}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type RoleKey = "models.primary" | "models.utility" | "models.image";

const modelRole = <K extends RoleKey>(key: K, id: "primary" | "utility" | "image") => ({
  key,
  get label(): string {
    return t(`settings.model.role.${id}`);
  },
  get hint(): string {
    return t(`settings.model.role.${id}Hint`);
  },
});

export const MODEL_ROLES = [
  modelRole("models.primary", "primary"),
  modelRole("models.utility", "utility"),
  modelRole("models.image", "image"),
] as const;

export interface ModelProvidersPanelProps extends SettingsFormProps, LoadProps {
  providers: readonly ProviderInfo[];
  /** Installed RAM, from the shell, for local-model guidance. */
  ramGb?: number;
  onRunCheck?: (modelRef: string) => void;
  onAddProvider?: () => void;
  onEditKey?: (provider: ProviderInfo) => void;
  /** Probe one provider's endpoint (`models.probe`); only ever on the owner's click. */
  onProbe?: (providerId: string) => void;
  /** The provider whose probe is running. */
  probing?: string | null;
  /** `models.list` failed; the panel shows the providers saved in settings beneath it. */
  listError?: string | null;
  onRetryList?: () => void;
  /**
   * Store a pasted key (`models.setKey`, then a probe). Resolves to an error to show, or null.
   * When set, Add / Replace key opens a field in the provider's row instead of `onEditKey`.
   */
  onSaveKey?: (providerId: string, key: string) => Promise<string | null>;
}

/** The inline Add / Replace key field (#504): the key goes to the vault and is checked at once. */
function KeyEditor({
  provider,
  onSave,
  onClose,
}: {
  provider: ProviderInfo;
  onSave: (key: string) => Promise<string | null>;
  onClose: () => void;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setSaving(true);
    setError(null);
    const problem = await onSave(draft.trim());
    setSaving(false);
    setDraft("");
    if (problem === null) onClose();
    else setError(problem);
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`${id}-key`} className="text-xs font-medium">
        {t("settings.model.key.newLabel", { name: provider.label })}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={`${id}-key`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-72 rounded-md border border-input bg-transparent px-2 text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={saving}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving || draft.trim() === ""}
          onClick={() => void save()}
        >
          {saving ? t("settings.model.key.saving") : t("settings.model.key.save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={saving}>
          {t("settings.model.key.cancel")}
        </Button>
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A model's name at level 1: its human label, or the ref when nothing names it. */
export function modelLabel(m: { ref: string; label?: string }): string {
  return m.label !== undefined && m.label.trim() !== "" ? m.label : m.ref;
}

/** The label an endpoint probe reported for `ref`, if any. */
function labelFromProbe(
  probed: readonly { ref: string; label?: string | undefined }[] | undefined,
  ref: string,
): { label?: string } {
  const label = probed?.find((m) => m.ref === ref)?.label;
  return label ? { label } : {};
}

export function ModelProvidersPanel({
  listError = null,
  onRetryList,
  providers,
  values,
  onChange,
  needsApproval,
  ramGb,
  onRunCheck,
  onAddProvider,
  onEditKey,
  onProbe,
  probing,
  loading,
  error,
  onRetry,
  onSaveKey,
}: ModelProvidersPanelProps): ReactElement {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const editKey = onSaveKey !== undefined ? (p: ProviderInfo) => setEditingKey(p.id) : onEditKey;
  // Embedding models cannot chat; they never appear as role choices.
  const models = providers
    .flatMap((p) => p.models)
    .filter((m) => m.capabilities?.embeddings !== true);
  const id = useId();
  const primaryRef = typeof values["models.primary"] === "string" ? values["models.primary"] : "";
  const primaryContext = providers.flatMap((p) => p.models).find((m) => m.ref === primaryRef)
    ?.capabilities?.contextWindow;
  const add = onAddProvider ? (
    <Button type="button" size="sm" onClick={onAddProvider}>
      {t("settings.model.addProvider")}
    </Button>
  ) : null;
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.model.title")}
      description={t("settings.model.description")}
    >
      <LoadGate
        label={t("settings.model.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group
          title={t("settings.model.providers")}
          actions={providers.length === 0 ? undefined : add}
        >
          {listError ? (
            <ErrorNotice
              what={t("settings.model.listFailed", { reason: listError })}
              did={t("settings.model.showingSaved")}
              {...(onRetryList ? { onRetry: onRetryList } : {})}
            />
          ) : null}
          {providers.length === 0 ? (
            <EmptyNotice text={t("settings.model.noProviders")} action={add} />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {providers.map((p) => (
                <li key={p.id} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{p.label}</span>
                    <span className="text-xs text-muted-foreground">{kindLabel(p.kind)}</span>
                    <StatusChip tone={STATUS_TONE[p.status]}>
                      {t(`settings.model.status.${p.status}`)}
                    </StatusChip>
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <KeyRound className="size-3.5" aria-hidden="true" />
                    {p.kind === "subscription"
                      ? t("settings.model.key.subscription")
                      : p.kind === "local"
                        ? p.baseURL === undefined
                          ? t("settings.model.key.localNone")
                          : t("settings.model.key.localEndpoint", { url: p.baseURL })
                        : p.keyRef === null
                          ? t("settings.model.key.none")
                          : t("settings.model.key.stored")}
                    {editKey && p.kind !== "local" && p.kind !== "subscription" ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        onClick={() => editKey(p)}
                        aria-label={t("settings.model.key.editNamed", {
                          has: p.keyRef !== null,
                          name: p.label,
                        })}
                      >
                        {p.keyRef === null
                          ? t("settings.model.key.add")
                          : t("settings.model.key.replace")}
                      </Button>
                    ) : null}
                  </p>
                  {onSaveKey !== undefined && editingKey === p.id ? (
                    <KeyEditor
                      provider={p}
                      onSave={(key) => onSaveKey(p.id, key)}
                      onClose={() => setEditingKey(null)}
                    />
                  ) : null}
                  {p.probe !== undefined ? (
                    <EndpointProbeStatus
                      label={p.label}
                      probe={p.probe}
                      probing={probing === p.id}
                      {...(onProbe ? { onProbe: () => onProbe(p.id) } : {})}
                    />
                  ) : null}
                  {p.models.length > 0 ? (
                    <ul
                      className="flex flex-col gap-1"
                      aria-label={t("settings.model.modelsOf", { name: p.label })}
                    >
                      {p.models.map((m) => (
                        <li key={m.ref} className="flex flex-wrap items-center gap-2">
                          <span className="text-sm">{modelLabel(m)}</span>
                          {m.label ? (
                            <code className="font-mono text-xs text-muted-foreground">{m.ref}</code>
                          ) : null}
                          {m.capabilities?.embeddings === true ? null : (
                            <ToolCheckBadge status={m.toolCheck} />
                          )}
                          <CapabilityChips capabilities={m.capabilities} />
                          {onRunCheck &&
                          m.toolCheck !== "running" &&
                          m.capabilities?.embeddings !== true ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() => onRunCheck(m.ref)}
                              aria-label={t("settings.model.runCheckOn", { name: modelLabel(m) })}
                            >
                              {m.toolCheck === "untested"
                                ? t("settings.model.runCheck")
                                : t("settings.model.checkAgain")}
                            </Button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Group>

        <Group title={t("settings.model.roles")} description={t("settings.model.rolesHint")}>
          {MODEL_ROLES.map((role) => {
            const current = str(values, role.key, role.key === "models.image" ? "none" : "");
            const options = models.some((m) => m.ref === current)
              ? models
              : current === "" || current === "none"
                ? models
                : [{ ref: current, toolCheck: "untested" as const }, ...models];
            return (
              <div key={role.key} className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:items-center">
                <label htmlFor={`${id}-${role.key}`} className="font-medium">
                  {role.label}
                  <span className="block text-xs font-normal text-muted-foreground">
                    {role.hint}
                  </span>
                </label>
                <div className="flex flex-col gap-1">
                  <NativeSelect
                    id={`${id}-${role.key}`}
                    className="min-w-72"
                    value={current}
                    onChange={(e) => onChange(role.key, e.target.value)}
                  >
                    {role.key === "models.image" ? (
                      <option value="none">{t("settings.model.none")}</option>
                    ) : null}
                    {current === "" ? <option value="">{t("settings.model.choose")}</option> : null}
                    {options.map((m) => (
                      <option key={m.ref} value={m.ref}>
                        {m.toolCheck === "failed"
                          ? t("settings.model.chatOnlyOption", { name: modelLabel(m) })
                          : modelLabel(m)}
                      </option>
                    ))}
                  </NativeSelect>
                  <SettingHint settingKey={role.key} />
                </div>
              </div>
            );
          })}
        </Group>

        <ContextSettingsGroup
          values={values}
          onChange={onChange}
          {...(primaryContext === undefined ? {} : { modelContextLength: primaryContext })}
        />
        <Group title={t("settings.model.local")} description={t("settings.model.localHint")}>
          <RamGuidance {...(ramGb === undefined ? {} : { ramGb })} />
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

function isProvider(v: unknown): v is ProviderInfo {
  return (
    typeof v === "object" &&
    v !== null &&
    "id" in v &&
    "label" in v &&
    "models" in v &&
    Array.isArray((v as { models: unknown }).models)
  );
}

/** Reads `models.providers` from settings (Gateways without `models.list`). */
export function providersFromSettings(values: Readonly<Record<string, unknown>>): ProviderInfo[] {
  const raw = values["models.providers"];
  return Array.isArray(raw) ? raw.filter(isProvider) : [];
}

const TOOL_CHECK: Record<ToolCheckStatus, ToolCheck> = {
  untested: "untested",
  "agent-capable": "passed",
  "chat-only": "failed",
};

/** A `models.list` provider as the panel shows it. */
export function providerInfoFromSummary(p: ModelProviderSummary): ProviderInfo {
  const subscription = p.kind === "claude-code" || p.kind === "codex";
  const kind: ProviderKind = subscription
    ? "subscription"
    : p.local
      ? "local"
      : p.kind === "openrouter"
        ? "openrouter"
        : "cloud";
  const status: ProviderInfo["status"] =
    p.probe.state === "reachable"
      ? "ok"
      : p.probe.state === "auth_failed"
        ? subscription
          ? "signed_out"
          : "invalid"
        : p.probe.state === "unreachable"
          ? "offline"
          : !p.local && !subscription && !p.keyConfigured
            ? "missing"
            : "unknown";
  return {
    id: p.id,
    label: p.label,
    kind,
    // The key itself never reaches the UI; the vault holds it under the provider's profile.
    keyRef: p.keyConfigured ? `the ${p.id} profile` : null,
    status,
    ...(p.baseURL === undefined || !p.local ? {} : { baseURL: p.baseURL }),
    probe: p.probe,
    models: p.models.map((m) => ({
      ref: m.ref,
      ...labelFromProbe(p.probe?.models, m.ref),
      toolCheck: TOOL_CHECK[m.toolCheck],
      ...(m.capabilities === undefined ? {} : { capabilities: m.capabilities }),
    })),
  };
}

const ROLE_OF: Record<string, "primary" | "utility"> = {
  "models.primary": "primary",
  "models.utility": "utility",
};

export interface ModelSectionProps {
  ramGb?: number;
  /** Shell override; defaults to `models.list`, then `models.providers` from settings. */
  providers?: readonly ProviderInfo[];
  /** Shell override; defaults to `models.check`. */
  onRunCheck?: (modelRef: string) => void;
  onAddProvider?: () => void;
  onEditKey?: (provider: ProviderInfo) => void;
}

/**
 * Connected Settings → Model & providers: `models.list` for providers, probes and roles;
 * `models.probe` and `models.check` only on the owner's click; `models.setRole` for the primary
 * and utility picks (a chat-only primary asks before `override`). Gateways without `models.*`
 * fall back to the `models.providers` setting.
 */
export function ModelSection(props: ModelSectionProps): ReactElement {
  const form = useSettingsForm();
  const call = useCall();
  const list = useGatewayQuery("models.list", {});
  const [probing, setProbing] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [chatOnly, setChatOnly] = useState<{ role: "primary" | "utility"; ref: string } | null>(
    null,
  );
  const live = list.data !== undefined && list.data.providers.length > 0;
  // setRole is memoised; it reads the latest labels through this ref.
  const labelOfRef = useRef<(ref: string) => string>((ref) => ref);
  const reload = list.reload;

  const providers: readonly ProviderInfo[] =
    props.providers ??
    (live
      ? (list.data?.providers ?? []).map((p) => {
          const info = providerInfoFromSummary(p);
          return checking === null
            ? info
            : {
                ...info,
                models: info.models.map((m) =>
                  m.ref === checking ? { ...m, toolCheck: "running" as const } : m,
                ),
              };
        })
      : providersFromSettings(form.values));
  const values = live
    ? {
        ...form.values,
        ...(list.data?.roles.primary === undefined
          ? {}
          : { "models.primary": list.data.roles.primary }),
        ...(list.data?.roles.utility === undefined
          ? {}
          : { "models.utility": list.data.roles.utility }),
      }
    : form.values;

  const setRole = useCallback(
    (role: "primary" | "utility", ref: string, override?: boolean) => {
      setActionError(null);
      setChatOnly(null);
      call("models.setRole", { role, ref, ...(override === true ? { override } : {}) }).then(
        () => reload(),
        (err: unknown) => {
          if (hasCode(err, "policy_denied")) setChatOnly({ role, ref });
          else
            setActionError(
              t("settings.model.err.use", {
                name: labelOfRef.current(ref),
                reason: messageOf(err),
              }),
            );
        },
      );
    },
    [call, reload],
  );

  const onChange = (key: string, value: unknown) => {
    const role = ROLE_OF[key];
    if (live && role !== undefined && typeof value === "string" && value.length > 0) {
      setRole(role, value);
      return;
    }
    form.onChange(key, value);
  };

  const onProbe = (providerId: string) => {
    setActionError(null);
    setProbing(providerId);
    call("models.probe", { providerId })
      .then(
        () => reload(),
        (err: unknown) => setActionError(t("settings.model.err.probe", { reason: messageOf(err) })),
      )
      .finally(() => setProbing(null));
  };

  /** Store a pasted key, then probe it at once so a refused key shows here (#504). */
  const onSaveKey = async (providerId: string, key: string): Promise<string | null> => {
    try {
      await call("models.setKey", { providerId, key });
    } catch (err) {
      return t("settings.model.key.failed", { reason: messageOf(err) });
    }
    try {
      const res = await call("models.probe", { providerId });
      if (res.provider.probe.state === "auth_failed") {
        return t("settings.model.key.refused", {
          reason: res.provider.probe.error ?? "HTTP 401",
        });
      }
      return null;
    } catch {
      // Stored; the probe can run again from the row.
      return null;
    } finally {
      reload();
    }
  };

  const onRunCheck =
    props.onRunCheck ??
    (live
      ? (ref: string) => {
          setActionError(null);
          setChecking(ref);
          call("models.check", { ref })
            .then(
              () => reload(),
              (err: unknown) =>
                setActionError(t("settings.model.err.check", { reason: messageOf(err) })),
            )
            .finally(() => setChecking(null));
        }
      : undefined);

  const labelOf = (ref: string): string =>
    modelLabel(providers.flatMap((p) => p.models).find((m) => m.ref === ref) ?? { ref });
  labelOfRef.current = labelOf;
  const chatOnlyLabel = chatOnly === null ? "" : labelOf(chatOnly.ref);
  const { providers: _p, onRunCheck: _r, ...rest } = props;
  return (
    <div className="flex flex-col gap-3">
      <ModelProvidersPanel
        {...rest}
        providers={providers}
        values={values}
        onChange={onChange}
        needsApproval={form.needsApproval}
        loading={
          (form.loading && Object.keys(form.values).length === 0) ||
          (list.loading && list.data === undefined && list.error === null)
        }
        error={form.error}
        onRetry={() => {
          form.reload();
          reload();
        }}
        probing={probing}
        listError={props.providers === undefined && !live ? list.error : null}
        onRetryList={reload}
        {...(live ? { onProbe } : {})}
        {...(live && props.onEditKey === undefined ? { onSaveKey } : {})}
        {...(onRunCheck === undefined ? {} : { onRunCheck })}
      />
      <AlertDialog
        open={chatOnly !== null}
        onOpenChange={(open) => {
          if (!open) setChatOnly(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.model.chatOnly.title", { name: chatOnlyLabel })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.model.chatOnly.description", {
                name: chatOnlyLabel,
                role: chatOnly?.role ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.model.chatOnly.keep")}</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => {
                if (chatOnly) setRole(chatOnly.role, chatOnly.ref, true);
              }}
            >
              {t("settings.model.chatOnly.useAnyway")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {actionError ? <ErrorNotice what={actionError} /> : null}
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
