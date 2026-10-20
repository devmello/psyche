import { Check, KeyRound, Loader, Plug } from "lucide-react";
import { type ReactElement, useId, useState } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { TCC_LABEL } from "../settings/ComputerUseSection.tsx";
import {
  CONNECTOR_CATALOG,
  ConnectAccessChoice,
  SCOPE_MODE_LABEL,
  type ScopeMode,
} from "../settings/ConnectorsSection.tsx";
import { RamGuidance, ToolCheckBadge } from "../settings/ModelSection.tsx";
import { CreaturePicker } from "../settings/PersonaSection.tsx";
import { ErrorNotice, Facts, RadioField, StatusChip } from "../settings/shared.tsx";
import type { ProviderKind, TccPermission } from "../settings/types.ts";
import type {
  ConnectedAccount,
  ModelChoice,
  OnboardingResult,
  PermissionAnswer,
  PersonaDraft,
  Workspace,
} from "./types.ts";

/** The six onboarding steps (UI design §3.19), each a controlled, presentational component. */

export const NAME_SUGGESTIONS = ["Juno", "Moss", "Pip"] as const;
export const DEFAULT_NAME = "Psyche";

// --- 1 Meet your agent ---------------------------------------------------------------------------

export function MeetStep({
  value,
  onChange,
}: {
  value: PersonaDraft;
  onChange: (next: PersonaDraft) => void;
}): ReactElement {
  const id = useId();
  const set = (patch: Partial<PersonaDraft>) => onChange({ ...value, ...patch });
  const name = value.name.trim() === "" ? DEFAULT_NAME : value.name.trim();
  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_14rem] md:items-start">
      <div className="flex min-w-0 flex-col gap-5" data-testid="onboarding-form">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            className="max-w-xs"
            maxLength={40}
            value={value.name}
            placeholder={DEFAULT_NAME}
            onChange={(e) => set({ name: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span id={`${id}-sugg`} className="text-muted-foreground">
              Suggestions:
            </span>
            <ul aria-labelledby={`${id}-sugg`} className="flex flex-wrap gap-1.5">
              {NAME_SUGGESTIONS.map((n) => (
                <li key={n}>
                  <Button
                    type="button"
                    size="xs"
                    variant={value.name === n ? "default" : "outline"}
                    aria-pressed={value.name === n}
                    onClick={() => set({ name: n })}
                  >
                    {n}
                  </Button>
                </li>
              ))}
              <li>
                <Button
                  type="button"
                  size="xs"
                  variant={value.name === DEFAULT_NAME ? "default" : "ghost"}
                  aria-pressed={value.name === DEFAULT_NAME}
                  onClick={() => set({ name: DEFAULT_NAME })}
                >
                  Keep “{DEFAULT_NAME}”
                </Button>
              </li>
            </ul>
          </div>
        </div>

        <RadioField
          label="Creature"
          inline
          value={value.creatureMode}
          onChange={(creatureMode) => set({ creatureMode })}
          options={[
            { value: "bundled", label: "Pick one" },
            { value: "describe", label: "Describe it in your words" },
          ]}
        />
        {value.creatureMode === "describe" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-desc`}>Describe {name}</Label>
            <Textarea
              id={`${id}-desc`}
              aria-describedby={`${id}-desc-hint`}
              placeholder="a small grey moth with lantern eyes"
              value={value.creatureDescription}
              onChange={(e) => set({ creatureDescription: e.target.value })}
              className="max-w-lg"
            />
            <p id={`${id}-desc-hint`} className="text-xs text-muted-foreground">
              With an image model, {name} is drawn from this. Without one, the creature below stands
              in.
            </p>
          </div>
        ) : null}
        <CreaturePicker
          label={value.creatureMode === "describe" ? "Stand-in creature" : "Bundled creatures"}
          value={value.creatureId}
          personaName={name}
          onChange={(creatureId) => set({ creatureId })}
        />

        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-tagline`}>Vibe or tagline</Label>
          <Input
            id={`${id}-tagline`}
            className="max-w-sm"
            maxLength={120}
            placeholder="Quiet wings, careful hands."
            value={value.tagline}
            onChange={(e) => set({ tagline: e.target.value })}
          />
        </div>
      </div>

      <figure
        aria-label="Preview"
        data-testid="onboarding-preview"
        className="flex flex-col items-center gap-2 self-start rounded-lg border border-gray-6 bg-gray-2 p-4 text-center md:sticky md:top-4"
      >
        <Avatar name={name} creature={value.creatureId} size={160} />
        <figcaption>
          <span className="block text-lg font-semibold">{name}</span>
          {value.tagline.trim() ? (
            <span className="block text-sm text-muted-foreground">{value.tagline.trim()}</span>
          ) : null}
          {value.creatureMode === "describe" && value.creatureDescription.trim() ? (
            <span className="mt-1 block text-xs text-muted-foreground">
              “{value.creatureDescription.trim()}”
            </span>
          ) : null}
        </figcaption>
      </figure>
    </div>
  );
}

// --- 2 Permissions ---------------------------------------------------------------------------------

export const ONBOARDING_PERMISSIONS: readonly TccPermission[] = [
  "accessibility",
  "screenRecording",
  "notifications",
];

const ANSWER: Record<PermissionAnswer, { tone: "success" | "danger" | "neutral"; text: string }> = {
  pending: { tone: "neutral", text: "Not asked" },
  granted: { tone: "success", text: "Allowed" },
  denied: { tone: "danger", text: "Denied in macOS" },
  skipped: { tone: "neutral", text: "Skipped" },
};

export function PermissionsStep({
  persona,
  value,
  onAllow,
  onSkip,
  busy = null,
}: {
  persona: string;
  value: Record<TccPermission, PermissionAnswer>;
  onAllow: (permission: TccPermission) => void;
  onSkip: (permission: TccPermission) => void;
  busy?: TccPermission | null;
}): ReactElement {
  const why: Record<TccPermission, string> = {
    accessibility: `Lets ${persona} click, type and use apps.`,
    screenRecording: `Lets ${persona} see app windows while it works.`,
    notifications: "Lets Psyche ask for approvals when this window is closed.",
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Each one is optional. macOS asks you to confirm; you can change them later in System
        Settings.
      </p>
      <ul className="flex flex-col gap-3">
        {ONBOARDING_PERMISSIONS.map((p) => {
          const answer = value[p];
          return (
            <li
              key={p}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-6 bg-gray-2 p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  {TCC_LABEL[p].name}
                  <StatusChip tone={ANSWER[answer].tone}>{ANSWER[answer].text}</StatusChip>
                </p>
                <p className="text-sm text-muted-foreground">{why[p]}</p>
                {answer === "denied" ? (
                  <p className="text-xs text-muted-foreground">
                    Turn it on later in System Settings → Privacy & Security.
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null || answer === "granted"}
                  onClick={() => onAllow(p)}
                  aria-label={`Allow ${TCC_LABEL[p].name}`}
                >
                  {busy === p ? (
                    <Loader className="motion-safe:animate-spin" aria-hidden="true" />
                  ) : null}
                  {answer === "granted" ? "Allowed" : "Allow"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null || answer === "granted"}
                  onClick={() => onSkip(p)}
                  aria-label={`Skip ${TCC_LABEL[p].name}`}
                >
                  Skip
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// --- 3 Connectors ----------------------------------------------------------------------------------

export function ConnectorsStep({
  persona,
  connected,
  onConnect,
  busy = false,
  error = null,
}: {
  persona: string;
  connected: readonly ConnectedAccount[];
  onConnect: (type: string, mode: ScopeMode) => void;
  busy?: boolean;
  error?: string | null;
}): ReactElement {
  const id = useId();
  const available = CONNECTOR_CATALOG.filter((c) => !connected.some((x) => x.type === c.type));
  const [type, setType] = useState<string>(available[0]?.type ?? "");
  const [mode, setMode] = useState<ScopeMode>("read");
  const current = available.some((c) => c.type === type) ? type : (available[0]?.type ?? "");
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Decide now which accounts to connect, one at a time. {persona} only sees what you connect,
        and you can add more later in Settings.
      </p>
      <section aria-labelledby={`${id}-connected`} className="flex flex-col gap-2">
        <h3 id={`${id}-connected`} className="text-label text-gray-11">
          Connected ({connected.length})
        </h3>
        {connected.length > 0 ? (
          <ul
            className="flex flex-col divide-y divide-gray-5 rounded-lg border border-gray-6"
            aria-label="Connected accounts"
          >
            {connected.map((c) => (
              <li key={c.type} className="flex items-center gap-2 px-3 py-2 text-sm">
                <Check className="size-4 text-success-text" aria-hidden="true" />
                <span className="min-w-0 flex-1 font-medium">{c.label}</span>
                <StatusChip tone="neutral">{SCOPE_MODE_LABEL[c.mode]}</StatusChip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Plug className="size-4" aria-hidden="true" />
            Nothing connected yet. You can skip this and connect accounts later in Settings.
          </p>
        )}
      </section>
      {error ? <ErrorNotice what={error} did="Nothing was connected." /> : null}
      {available.length === 0 ? (
        <p className="text-sm">Every account type is connected.</p>
      ) : (
        <div className="elevation-1 flex flex-col gap-3 rounded-lg p-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-type`}>
              {connected.length === 0 ? "Account to connect" : "Connect another account"}
            </Label>
            <NativeSelect
              id={`${id}-type`}
              className="min-w-64"
              value={current}
              onChange={(e) => setType(e.target.value)}
            >
              {available.map((c) => (
                <option key={c.type} value={c.type}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <ConnectAccessChoice
            label={`What can ${persona} do with it?`}
            value={mode}
            onChange={setMode}
            persona={persona}
          />
          <div>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => onConnect(current, mode)}
            >
              {busy ? <Loader className="motion-safe:animate-spin" aria-hidden="true" /> : null}
              Connect
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// --- 4 Model & provider ----------------------------------------------------------------------------

export interface ModelOption {
  ref: string;
  label: string;
  hint: string;
}

export const PROVIDERS: Record<
  ProviderKind,
  readonly { id: string; label: string; defaultModel: string; models: readonly ModelOption[] }[]
> = {
  cloud: [
    {
      id: "anthropic",
      label: "Anthropic",
      defaultModel: "anthropic/claude-sonnet-5-5",
      models: [
        {
          ref: "anthropic/claude-sonnet-5-5",
          label: "Claude Sonnet 5.5",
          hint: "Recommended: fast, strong with tools",
        },
        {
          ref: "anthropic/claude-opus-5-5",
          label: "Claude Opus 5.5",
          hint: "Most capable, slower and pricier",
        },
        {
          ref: "anthropic/claude-haiku-5-5",
          label: "Claude Haiku 5.5",
          hint: "Fastest and cheapest",
        },
      ],
    },
    {
      id: "openai",
      label: "OpenAI",
      defaultModel: "openai/gpt-5.5",
      models: [
        { ref: "openai/gpt-5.5", label: "GPT-5.5", hint: "OpenAI's general model" },
        { ref: "openai/gpt-5.5-mini", label: "GPT-5.5 mini", hint: "Faster and cheaper" },
      ],
    },
    {
      id: "google",
      label: "Google",
      defaultModel: "google/gemini-3-pro",
      models: [
        { ref: "google/gemini-3-pro", label: "Gemini 3 Pro", hint: "Google's strongest model" },
        { ref: "google/gemini-3-flash", label: "Gemini 3 Flash", hint: "Faster and cheaper" },
      ],
    },
  ],
  subscription: [
    {
      id: "anthropic",
      label: "Claude subscription",
      defaultModel: "anthropic/claude-sonnet-5-5",
      models: [
        { ref: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Recommended" },
        {
          ref: "anthropic/claude-opus-5-5",
          label: "Claude Opus 5.5",
          hint: "Uses your plan faster",
        },
      ],
    },
    {
      id: "openai",
      label: "ChatGPT subscription",
      defaultModel: "openai/gpt-5.5",
      models: [{ ref: "openai/gpt-5.5", label: "GPT-5.5", hint: "Included with your plan" }],
    },
  ],
  openrouter: [
    {
      id: "openrouter",
      label: "OpenRouter",
      defaultModel: "openrouter/auto",
      models: [
        { ref: "openrouter/auto", label: "Auto", hint: "OpenRouter picks per request" },
        {
          ref: "openrouter/anthropic/claude-sonnet-5-5",
          label: "Claude Sonnet 5.5",
          hint: "Through OpenRouter",
        },
      ],
    },
  ],
  local: [
    {
      id: "ollama",
      label: "Ollama",
      defaultModel: "ollama/qwen3.8-27b",
      models: [
        {
          ref: "ollama/qwen3.8-27b",
          label: "Qwen 3.8 27B",
          hint: "Good with tools; 32 GB RAM or more",
        },
        { ref: "ollama/glm-4.7-flash", label: "GLM 4.7 Flash", hint: "Lighter; 16 GB RAM" },
      ],
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      defaultModel: "lmstudio/gemma4-31b",
      models: [{ ref: "lmstudio/gemma4-31b", label: "Gemma 4 31B", hint: "32 GB RAM or more" }],
    },
  ],
};

const OTHER_MODEL = "__other__";

export function defaultModelChoice(kind: ProviderKind): ModelChoice {
  const first = PROVIDERS[kind][0];
  return {
    kind,
    provider: first?.id ?? kind,
    modelRef: first?.defaultModel ?? "",
    keyRef: null,
    toolCheck: "untested",
  };
}

export function ModelStep({
  value,
  onChange,
  ramGb,
  onSaveKey,
  onCheck,
  keyError = null,
}: {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  ramGb?: number;
  /** Stores the key; when absent the key field explains it can be added later. */
  onSaveKey?: (key: string) => void;
  onCheck?: () => void;
  keyError?: string | null;
}): ReactElement {
  const id = useId();
  const [key, setKey] = useState("");
  const providers = PROVIDERS[value.kind];
  const models = providers.find((p) => p.id === value.provider)?.models ?? [];
  const [other, setOther] = useState(false);
  const known = models.some((m) => m.ref === value.modelRef);
  const picked = other || !known ? OTHER_MODEL : value.modelRef;
  const needsKey = value.kind === "cloud" || value.kind === "openrouter";
  return (
    <div className="flex flex-col gap-4">
      <RadioField
        label="How should the agent think?"
        value={value.kind}
        onChange={(kind) => {
          setOther(false);
          onChange(defaultModelChoice(kind));
        }}
        options={[
          {
            value: "cloud",
            label: "Cloud API key",
            hint: "Anthropic, OpenAI or Google; pay per use.",
          },
          {
            value: "subscription",
            label: "Subscription",
            hint: "Sign in with a plan you already have.",
          },
          { value: "openrouter", label: "OpenRouter", hint: "One key for many models." },
          { value: "local", label: "Local model", hint: "Runs on this Mac; nothing leaves it." },
        ]}
      />
      {providers.length > 1 ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-provider`}>Provider</Label>
          <NativeSelect
            id={`${id}-provider`}
            className="min-w-56"
            value={value.provider}
            onChange={(e) => {
              const p = providers.find((x) => x.id === e.target.value);
              setOther(false);
              onChange({
                ...value,
                provider: e.target.value,
                modelRef: p?.defaultModel ?? value.modelRef,
                keyRef: null,
                toolCheck: "untested",
              });
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      ) : null}
      <RadioField
        label="Model"
        value={picked}
        onChange={(ref) => {
          if (ref === OTHER_MODEL) {
            setOther(true);
            return;
          }
          setOther(false);
          onChange({ ...value, modelRef: ref, toolCheck: "untested" });
        }}
        options={[
          ...models.map((m) => ({ value: m.ref, label: m.label, hint: m.hint })),
          {
            value: OTHER_MODEL,
            label: "Another model",
            hint: "Type its id, as the provider names it",
          },
        ]}
      >
        {picked === OTHER_MODEL ? (
          <div className="ml-6 flex flex-col gap-1">
            <Label htmlFor={`${id}-model`} className="sr-only">
              Model id
            </Label>
            <Input
              id={`${id}-model`}
              className="max-w-sm"
              placeholder={`${value.provider}/model-name`}
              value={value.modelRef}
              onChange={(e) =>
                onChange({ ...value, modelRef: e.target.value, toolCheck: "untested" })
              }
            />
          </div>
        ) : null}
      </RadioField>

      {needsKey ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-key`} className="gap-1.5">
            <KeyRound className="size-3.5" aria-hidden="true" /> API key
          </Label>
          {value.keyRef ? (
            <p className="text-sm" role="status">
              Stored in the vault as <code className="font-mono">{value.keyRef}</code>. The agent
              never sees it.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <Input
                  id={`${id}-key`}
                  type="password"
                  autoComplete="off"
                  className="max-w-sm"
                  aria-describedby={`${id}-key-hint`}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  disabled={!onSaveKey}
                />
                {onSaveKey ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={key.trim() === ""}
                    onClick={() => {
                      onSaveKey(key.trim());
                      setKey("");
                    }}
                  >
                    Save to vault
                  </Button>
                ) : null}
              </div>
              <p id={`${id}-key-hint`} className="text-xs text-muted-foreground">
                {onSaveKey
                  ? "Goes straight to the Psyche vault. Psyche never shows it again."
                  : "Add the key later in Settings → Model & providers."}
              </p>
            </>
          )}
          {keyError ? <ErrorNotice what={keyError} did="The key was not stored." /> : null}
        </div>
      ) : null}

      {value.kind === "subscription" ? (
        <p className="text-sm text-muted-foreground">
          You'll sign in with the provider after onboarding; Psyche stores only the session token in
          the vault.
        </p>
      ) : null}

      {value.kind === "local" ? <RamGuidance {...(ramGb === undefined ? {} : { ramGb })} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Tool-calling check</span>
        <ToolCheckBadge status={value.toolCheck} />
        {onCheck && value.toolCheck !== "running" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onCheck}
            disabled={value.modelRef.trim() === "" || (needsKey && value.keyRef === null)}
          >
            {value.toolCheck === "untested" ? "Run check" : "Check again"}
          </Button>
        ) : null}
      </div>
      {value.toolCheck === "failed" ? (
        <p className="text-sm text-approval-text">
          This model can chat but can't use tools reliably, so it won't act for you. Pick another or
          continue in chat-only mode.
        </p>
      ) : null}
    </div>
  );
}

// --- 5 Where the agent works ----------------------------------------------------------------------

export function WhereStep({
  persona,
  value,
  onChange,
  vmAvailable = true,
}: {
  persona: string;
  value: Workspace;
  onChange: (next: Workspace) => void;
  vmAvailable?: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <RadioField
        label={`Where should ${persona} work?`}
        value={value}
        onChange={onChange}
        options={[
          {
            value: "local",
            label: "This Mac",
            hint: `${persona} uses your apps with the permissions you chose. Commands run in a sandbox.`,
          },
          {
            value: "vm",
            label: "A Mac inside Psyche (VM mode)",
            disabled: !vmAvailable,
            hint: vmAvailable
              ? `${persona} gets its own macOS guest. Its clicks and browsing stay inside it.`
              : "Needs macOS 15 or later on Apple silicon.",
          },
        ]}
      />
      <div className="rounded-lg border border-gray-6 bg-gray-2 p-4 text-sm">
        <h3 className="mb-2 font-semibold">
          {value === "vm" ? "VM mode defaults" : "This Mac defaults"}
        </h3>
        {value === "vm" ? (
          <Facts
            items={[
              { term: "Guest", value: "macOS, 4 vCPU, 8 GB memory, 80 GB disk (adjustable)" },
              {
                term: "The guest sees",
                value: "Its own disk, folders you share (read only by default) and the clipboard",
              },
              { term: "It can't see", value: "Your files, apps, Keychain or browser sessions" },
              { term: "You watch", value: "The guest display in a pane, with Take control" },
            ]}
          />
        ) : (
          <Facts
            items={[
              {
                term: "Apps",
                value: "Each app asks on first use: Off, Read only or Read and interact",
              },
              { term: "Files", value: "Only folders you share in Settings → File access" },
              { term: "Commands", value: "In a container; never on your Mac's shell" },
              { term: "Stop", value: "Esc stops computer use at any time" },
            ]}
          />
        )}
      </div>
    </div>
  );
}

// --- 6 Done ----------------------------------------------------------------------------------------

export function DoneStep({ result }: { result: OnboardingResult }): ReactElement {
  const p = result.persona;
  const granted = (Object.entries(result.permissions) as [TccPermission, PermissionAnswer][])
    .filter(([, a]) => a === "granted")
    .map(([k]) => TCC_LABEL[k].name);
  return (
    <div className="flex flex-col items-start gap-4">
      <div className="flex items-center gap-4">
        <Avatar name={p.name} creature={p.creatureId} size={64} />
        <div>
          <p className="text-lg font-semibold">{p.name} is ready.</p>
          <p className="text-sm text-muted-foreground">
            The main chat opens with {p.name}'s first message.
          </p>
        </div>
      </div>
      <Facts
        className="text-sm"
        items={[
          { term: "Tagline", value: p.tagline || "None" },
          { term: "Permissions", value: granted.length > 0 ? granted.join(", ") : "None yet" },
          {
            term: "Accounts",
            value:
              result.connectors.length > 0
                ? result.connectors
                    .map((c) => `${c.label} (${SCOPE_MODE_LABEL[c.mode].toLowerCase()})`)
                    .join(", ")
                : "None yet",
          },
          {
            term: "Model",
            value: (
              <span className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{result.model.modelRef}</code>
                <ToolCheckBadge status={result.model.toolCheck} />
              </span>
            ),
          },
          { term: "Works in", value: result.workspace === "vm" ? "VM mode" : "This Mac" },
        ]}
      />
    </div>
  );
}
