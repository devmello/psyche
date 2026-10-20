import { KeyRound, Loader } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Button } from "../../components/ui/button.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { cn } from "../../lib/utils.ts";
import {
  EmptyNotice,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
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
}

export function ModelProvidersPanel({
  providers,
  values,
  onChange,
  needsApproval,
  ramGb,
  onRunCheck,
  onAddProvider,
  onEditKey,
  loading,
  error,
  onRetry,
}: ModelProvidersPanelProps): ReactElement {
  const models = providers.flatMap((p) => p.models);
  const id = useId();
  const add = onAddProvider ? (
    <Button type="button" variant="outline" size="sm" onClick={onAddProvider}>
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
        <Group title="Providers" actions={add}>
          {providers.length === 0 ? (
            <EmptyNotice text="No model provider yet. Add a key, a subscription or a local model." />
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
                      ? "No key needed."
                      : p.keyRef === null
                        ? "No key stored."
                        : `Key stored in the vault as ${p.keyRef}. Psyche never shows it.`}
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
                  {p.models.length > 0 ? (
                    <ul className="flex flex-col gap-1" aria-label={`${p.label} models`}>
                      {p.models.map((m) => (
                        <li key={m.ref} className="flex flex-wrap items-center gap-2">
                          <code className="font-mono text-xs">{m.ref}</code>
                          <ToolCheckBadge status={m.toolCheck} />
                          {onRunCheck && m.toolCheck !== "running" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() => onRunCheck(m.ref)}
                              aria-label={`Run the tool-calling check on ${m.ref}`}
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
                        {m.ref}
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

/** Reads `models.providers` from settings (there is no `providers.*` method yet). */
export function providersFromSettings(values: Readonly<Record<string, unknown>>): ProviderInfo[] {
  const raw = values["models.providers"];
  return Array.isArray(raw) ? raw.filter(isProvider) : [];
}

export interface ModelSectionProps {
  ramGb?: number;
  /** Shell override; defaults to `models.providers` from settings. */
  providers?: readonly ProviderInfo[];
  onRunCheck?: (modelRef: string) => void;
  onAddProvider?: () => void;
  onEditKey?: (provider: ProviderInfo) => void;
}

export function ModelSection(props: ModelSectionProps): ReactElement {
  const form = useSettingsForm();
  const providers = props.providers ?? providersFromSettings(form.values);
  return (
    <div className="flex flex-col gap-3">
      <ModelProvidersPanel
        {...props}
        providers={providers}
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
