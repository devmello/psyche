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

const KIND_LABEL: Record<ProviderKind, string> = {
  cloud: "Cloud API key",
  subscription: "Subscription",
  openrouter: "OpenRouter",
  local: "Local",
};

const STATUS: Record<
  ProviderInfo["status"],
  { tone: "success" | "danger" | "neutral"; text: string }
> = {
  ok: { tone: "success", text: "Connected" },
  missing: { tone: "neutral", text: "No key yet" },
  invalid: { tone: "danger", text: "Key rejected" },
  offline: { tone: "danger", text: "Not reachable" },
  unknown: { tone: "neutral", text: "Not checked" },
};

export function ToolCheckBadge({ status }: { status: ToolCheck }): ReactElement {
  switch (status) {
    case "passed":
      return <StatusChip tone="success">Tool calling: passed</StatusChip>;
    case "failed":
      return <StatusChip tone="approval">Chat only: tool-calling check failed</StatusChip>;
    case "running":
      return (
        <StatusChip tone="info">
          <Loader className="size-3 motion-safe:animate-spin" aria-hidden="true" />
          Checking tool calling
        </StatusChip>
      );
    case "untested":
      return <StatusChip tone="neutral">Tool calling: not checked</StatusChip>;
  }
}

const PROBE: Record<
  EndpointProbe["state"],
  { tone: "success" | "danger" | "neutral"; text: string }
> = {
  not_probed: { tone: "neutral", text: "Endpoint not checked" },
  reachable: { tone: "success", text: "Reachable" },
  unreachable: { tone: "danger", text: "Not reachable" },
  auth_failed: { tone: "danger", text: "Key refused" },
  error: { tone: "danger", text: "Check failed" },
};

function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M context`;
  return `${Math.round(tokens / 1024)}K context`;
}

/** What a model can probably do, as text chips (B4). Unknown flags show nothing. */
export function CapabilityChips({
  capabilities,
}: {
  capabilities: ModelCapabilityGuess | undefined;
}): ReactElement | null {
  if (capabilities === undefined) return null;
  const chips: string[] = [];
  if (capabilities.embeddings === true) chips.push("Embeddings");
  if (capabilities.toolCalling === true) chips.push("Tools");
  if (capabilities.toolCalling === false && capabilities.embeddings !== true)
    chips.push("No tools");
  if (capabilities.vision === true) chips.push("Vision");
  if (capabilities.reasoning === true) chips.push("Reasoning");
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
        <span className="text-xs text-muted-foreground">(guessed from the name)</span>
      ) : null}
    </span>
  );
}

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
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
  const chip = PROBE[probe.state];
  const detail = [
    probe.state === "reachable"
      ? `${probe.models.length} ${probe.models.length === 1 ? "model" : "models"}`
      : null,
    probe.server ?? null,
    probe.latencyMs === undefined ? null : `${probe.latencyMs} ms`,
    probe.probedAt === undefined ? null : `checked ${timeOf(probe.probedAt)}`,
  ].filter((x): x is string => x !== null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Server className="size-3.5" aria-hidden="true" />
        {probing === true ? (
          <StatusChip tone="info">
            <Loader className="size-3 motion-safe:animate-spin" aria-hidden="true" />
            Checking the endpoint
          </StatusChip>
        ) : (
          <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
        )}
        {detail.length > 0 ? <span>{detail.join(" · ")}</span> : null}
        {onProbe && probing !== true ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            onClick={onProbe}
            aria-label={`Check the ${label} endpoint`}
          >
            {probe.state === "not_probed" ? "Check endpoint" : "Check again"}
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
export const RAM_TIERS = [
  { minGb: 16, label: "16 GB", fits: "about 9B models (Gemma 4 E-series, Qwen3.5 small)" },
  { minGb: 32, label: "32 GB", fits: "27–31B models (Qwen3.8-27B, Gemma 4 31B, GLM-4.7-Flash)" },
  { minGb: 96, label: "96–128 GB", fits: "120B MoE models (gpt-oss-120b, Mistral Small 4)" },
] as const;

export function RamGuidance({ ramGb }: { ramGb?: number }): ReactElement {
  const match =
    ramGb === undefined ? null : ([...RAM_TIERS].reverse().find((t) => ramGb >= t.minGb) ?? null);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground">
        {ramGb === undefined
          ? "Local models need memory. Rough fit by RAM:"
          : match === null
            ? `This Mac has ${ramGb} GB. Local models need at least 16 GB; use a cloud provider instead.`
            : `This Mac has ${ramGb} GB, so ${match.fits} fit.`}
      </p>
      <ul className="grid gap-1">
        {RAM_TIERS.map((t) => (
          <li
            key={t.label}
            className={cn(
              "flex gap-2 rounded-md px-2 py-1",
              match?.label === t.label ? "bg-accent-3 text-accent-12" : "text-gray-11",
            )}
          >
            <span className="w-20 shrink-0 font-medium">{t.label}</span>
            <span>
              {t.fits}
              {match?.label === t.label ? <span className="sr-only"> (this Mac)</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export const MODEL_ROLES = [
  { key: "models.primary", label: "Primary", hint: "Chat, tasks and tools" },
  {
    key: "models.utility",
    label: "Utility",
    hint: "Titles, summaries and the auto-mode classifier",
  },
  { key: "models.image", label: "Image", hint: "Avatar changes; none means the bundled creatures" },
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
}: ModelProvidersPanelProps): ReactElement {
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
      Add a provider
    </Button>
  ) : null;
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title="Model & providers"
      description="A model you pick is used as chosen. If it fails, Psyche says so instead of falling back."
    >
      <LoadGate
        label="model providers"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title="Providers" actions={providers.length === 0 ? undefined : add}>
          {listError ? (
            <ErrorNotice
              what={`Psyche couldn't list the models (${listError}).`}
              did="Showing the providers saved in settings."
              {...(onRetryList ? { onRetry: onRetryList } : {})}
            />
          ) : null}
          {providers.length === 0 ? (
            <EmptyNotice
              text="No model provider yet. Add a key, a subscription or a local model."
              action={add}
            />
          ) : (
            <ul className="flex flex-col divide-y divide-gray-6">
              {providers.map((p) => (
                <li key={p.id} className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{p.label}</span>
                    <span className="text-xs text-muted-foreground">{KIND_LABEL[p.kind]}</span>
                    <StatusChip tone={STATUS[p.status].tone}>{STATUS[p.status].text}</StatusChip>
                  </div>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <KeyRound className="size-3.5" aria-hidden="true" />
                    {p.kind === "local"
                      ? p.baseURL === undefined
                        ? "No key needed."
                        : `No key needed. Endpoint ${p.baseURL}.`
                      : p.keyRef === null
                        ? "No key stored."
                        : "Key stored in the vault. Psyche never shows it."}
                    {onEditKey && p.kind !== "local" ? (
                      <Button
                        type="button"
                        variant="link"
                        size="xs"
                        onClick={() => onEditKey(p)}
                        aria-label={`${p.keyRef === null ? "Add" : "Replace"} the ${p.label} key`}
                      >
                        {p.keyRef === null ? "Add key" : "Replace key"}
                      </Button>
                    ) : null}
                  </p>
                  {p.probe !== undefined ? (
                    <EndpointProbeStatus
                      label={p.label}
                      probe={p.probe}
                      probing={probing === p.id}
                      {...(onProbe ? { onProbe: () => onProbe(p.id) } : {})}
                    />
                  ) : null}
                  {p.models.length > 0 ? (
                    <ul className="flex flex-col gap-1" aria-label={`${p.label} models`}>
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
                              aria-label={`Run the tool-calling check on ${modelLabel(m)}`}
                            >
                              {m.toolCheck === "untested" ? "Run check" : "Check again"}
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

        <Group
          title="Model roles"
          description="Each role uses one model. Models that fail the tool-calling check are chat only."
        >
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
                    {role.key === "models.image" ? <option value="none">None</option> : null}
                    {current === "" ? <option value="">Choose a model</option> : null}
                    {options.map((m) => (
                      <option key={m.ref} value={m.ref}>
                        {modelLabel(m)}
                        {m.toolCheck === "failed" ? " (chat only)" : ""}
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
        <Group title="Local models" description="Run models on this Mac with Ollama or LM Studio.">
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
  const kind: ProviderKind = p.local ? "local" : p.kind === "openrouter" ? "openrouter" : "cloud";
  const status: ProviderInfo["status"] =
    p.probe.state === "reachable"
      ? "ok"
      : p.probe.state === "auth_failed"
        ? "invalid"
        : p.probe.state === "unreachable"
          ? "offline"
          : !p.local && !p.keyConfigured
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
            setActionError(`Psyche couldn't use ${labelOfRef.current(ref)} (${messageOf(err)}).`);
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
        (err: unknown) => setActionError(`Psyche couldn't check the endpoint (${messageOf(err)}).`),
      )
      .finally(() => setProbing(null));
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
                setActionError(`Psyche couldn't run the check (${messageOf(err)}).`),
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
            <AlertDialogTitle>Use {chatOnlyLabel} without tools?</AlertDialogTitle>
            <AlertDialogDescription>
              {chatOnlyLabel} failed the tool-calling check, so it can chat but can't use tools. It
              would be the {chatOnly?.role} model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep the current model</AlertDialogCancel>
            <Button
              type="button"
              onClick={() => {
                if (chatOnly) setRole(chatOnly.role, chatOnly.ref, true);
              }}
            >
              Use anyway
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {actionError ? <ErrorNotice what={actionError} /> : null}
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
