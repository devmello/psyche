import { Check, CircleAlert, KeyRound, Loader, Plug } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useId, useState } from "react";
import { Avatar } from "../../avatar/Avatar.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Checkbox } from "../../components/ui/checkbox.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { useSettings } from "../../data/hooks.ts";
import { activeI18n, t } from "../../i18n/core.ts";
import { LANGUAGE_SETTING } from "../../i18n/locale.ts";
import { useCopy } from "../../lib/clipboard.ts";
import { TCC_LABEL } from "../settings/ComputerUseSection.tsx";
import {
  ConnectAccessChoice,
  needsSetup,
  offeredCatalog,
  SCOPE_MODE_LABEL,
  type ScopeMode,
} from "../settings/ConnectorsSection.tsx";
import { LanguageSelect } from "../settings/LanguageSettings.tsx";
import { type MacHelperStatus, MacHelperStatusRow } from "../settings/MacHelperStatus.tsx";
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
  SetupCheck,
  Workspace,
} from "./types.ts";

/** The six onboarding steps (UI design §3.19), each a controlled, presentational component. */

export const NAME_SUGGESTIONS = ["Juno", "Moss", "Pip"] as const;
export const DEFAULT_NAME = "Psyche";

// --- 1 Meet your agent ---------------------------------------------------------------------------

/**
 * The language, first thing in onboarding (A12, #621): written to `ui.language` at once, so the
 * rest of the flow already reads in it (AppearanceProvider remounts the app on a change).
 */
function OnboardingLanguage(): ReactElement {
  const id = useId();
  const { settings, set } = useSettings();
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <div className="flex min-w-0 flex-col">
        <Label htmlFor={`${id}-language`}>{t("onboarding.language.label")}</Label>
        <span id={`${id}-language-hint`} className="text-callout text-label-secondary">
          {t("onboarding.language.hint")}
        </span>
      </div>
      <LanguageSelect
        id={`${id}-language`}
        className="min-w-48"
        value={settings[LANGUAGE_SETTING]}
        describedBy={`${id}-language-hint`}
        onChange={(language) => void set(LANGUAGE_SETTING, language).catch(() => {})}
      />
    </div>
  );
}

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
  // The avatar at 160 px, the tile grid below it, then name and tagline (redesign §5.9).
  return (
    <div className="flex flex-col gap-6">
      <OnboardingLanguage />
      <figure
        aria-label={t("onboarding.agent.preview")}
        data-testid="onboarding-preview"
        className="flex flex-col items-center gap-2 text-center"
      >
        <Avatar name={name} creature={value.creatureId} size={160} />
        <figcaption>
          <span className="block text-title-2 text-label-primary">{name}</span>
          {value.tagline.trim() ? (
            <span className="block text-callout text-label-secondary">{value.tagline.trim()}</span>
          ) : null}
          {value.creatureMode === "describe" && value.creatureDescription.trim() ? (
            <span className="mt-1 block text-callout text-label-tertiary">
              “{value.creatureDescription.trim()}”
            </span>
          ) : null}
        </figcaption>
      </figure>

      <div className="flex min-w-0 flex-col gap-5" data-testid="onboarding-form">
        <CreaturePicker
          label={
            value.creatureMode === "describe"
              ? t("onboarding.agent.standIn")
              : t("onboarding.agent.bundled")
          }
          value={value.creatureId}
          personaName={name}
          onChange={(creatureId) => set({ creatureId })}
        />
        <RadioField
          label={t("onboarding.agent.creature")}
          inline
          value={value.creatureMode}
          onChange={(creatureMode) => set({ creatureMode })}
          options={[
            { value: "bundled", label: t("onboarding.agent.pickOne") },
            { value: "describe", label: t("onboarding.agent.describeIt") },
          ]}
        />
        {value.creatureMode === "describe" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-desc`}>{t("onboarding.agent.describe", { name })}</Label>
            <Textarea
              id={`${id}-desc`}
              aria-describedby={`${id}-desc-hint`}
              placeholder={t("onboarding.agent.describePlaceholder")}
              value={value.creatureDescription}
              onChange={(e) => set({ creatureDescription: e.target.value })}
            />
            <p id={`${id}-desc-hint`} className="text-callout text-label-secondary">
              {t("onboarding.agent.describeHint", { name })}
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-name`}>{t("onboarding.agent.name")}</Label>
          <Input
            id={`${id}-name`}
            maxLength={40}
            value={value.name}
            placeholder={DEFAULT_NAME}
            onChange={(e) => set({ name: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span id={`${id}-sugg`} className="text-callout text-label-secondary">
              {t("onboarding.agent.suggestions")}
            </span>
            <ul aria-labelledby={`${id}-sugg`} className="flex flex-wrap gap-1.5">
              {NAME_SUGGESTIONS.map((n) => (
                <li key={n}>
                  <Button
                    type="button"
                    size="xs"
                    variant={value.name === n ? "secondary" : "ghost"}
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
                  variant={value.name === DEFAULT_NAME ? "secondary" : "ghost"}
                  aria-pressed={value.name === DEFAULT_NAME}
                  onClick={() => set({ name: DEFAULT_NAME })}
                >
                  {t("onboarding.agent.keep", { name: DEFAULT_NAME })}
                </Button>
              </li>
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-tagline`}>{t("onboarding.agent.tagline")}</Label>
          <Input
            id={`${id}-tagline`}
            maxLength={120}
            placeholder={t("onboarding.agent.taglinePlaceholder")}
            value={value.tagline}
            onChange={(e) => set({ tagline: e.target.value })}
          />
        </div>
      </div>
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
  pending: {
    tone: "neutral",
    get text() {
      return t("onboarding.permission.pending");
    },
  },
  granted: {
    tone: "success",
    get text() {
      return t("onboarding.permission.granted");
    },
  },
  denied: {
    tone: "danger",
    get text() {
      return t("onboarding.permission.denied");
    },
  },
  skipped: {
    tone: "neutral",
    get text() {
      return t("onboarding.permission.skipped");
    },
  },
  unavailable: {
    tone: "neutral",
    get text() {
      return t("onboarding.permission.unavailable");
    },
  },
};

export function PermissionsStep({
  persona,
  value,
  onAllow,
  onSkip,
  busy = null,
  helper,
}: {
  persona: string;
  value: Record<TccPermission, PermissionAnswer>;
  onAllow: (permission: TccPermission) => void;
  onSkip: (permission: TccPermission) => void;
  busy?: TccPermission | null;
  helper?: MacHelperStatus;
}): ReactElement {
  const why: Record<TccPermission, string> = {
    accessibility: t("onboarding.permission.why.accessibility", { name: persona }),
    screenRecording: t("onboarding.permission.why.screenRecording", { name: persona }),
    notifications: t("onboarding.permission.why.notifications"),
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-reading text-label-secondary">{t("onboarding.permission.intro")}</p>
      {helper ? <MacHelperStatusRow state={helper} /> : null}
      <ul className="flex flex-col gap-3">
        {ONBOARDING_PERMISSIONS.map((p) => {
          const answer = value[p];
          return (
            <li
              key={p}
              className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised p-3 shadow-elevation-1"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-headline text-label-primary">
                  {TCC_LABEL[p].name}
                  <StatusChip tone={ANSWER[answer].tone}>{ANSWER[answer].text}</StatusChip>
                </p>
                <p className="text-callout text-label-secondary">{why[p]}</p>
                {answer === "denied" ? (
                  <p className="text-callout text-label-secondary">
                    {t("onboarding.permission.deniedHint")}
                  </p>
                ) : answer === "unavailable" ? (
                  <p className="text-callout text-label-secondary">
                    {t("onboarding.permission.unavailableHint")}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy !== null || answer === "granted"}
                  onClick={() => onAllow(p)}
                  aria-label={t("onboarding.permission.allowLabel", { name: TCC_LABEL[p].name })}
                >
                  {busy === p ? (
                    <Loader className="motion-safe:animate-spin" aria-hidden="true" />
                  ) : null}
                  {busy === p
                    ? t("onboarding.permission.asking")
                    : answer === "granted"
                      ? t("onboarding.permission.granted")
                      : t("onboarding.permission.allow")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null || answer === "granted"}
                  onClick={() => onSkip(p)}
                  aria-label={t("onboarding.permission.skipLabel", { name: TCC_LABEL[p].name })}
                >
                  {t("onboarding.permission.skip")}
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

/** First run on a Mac: these apps start selected (docs/connectors/apple-apps-2026.md §7.2). */
export const DEFAULT_MAC_APPS = [
  "apple:calendar",
  "apple:reminders",
  "apple:mail",
  "apple:notes",
] as const;

/** Apps on this Mac (the helper's apps; no sign-in) as opposed to accounts that sign in online. */
export const isOnThisMac = (type: string): boolean => type.startsWith("apple:");

/** On this Mac: the default apps first, in their order, then the rest as the catalogue lists them. */
function macOrder(a: string, b: string): number {
  const rank = (t: string) => {
    const i = (DEFAULT_MAC_APPS as readonly string[]).indexOf(t);
    return i === -1 ? DEFAULT_MAC_APPS.length : i;
  };
  return rank(a) - rank(b);
}

export function ConnectorsStep({
  persona,
  connected,
  onConnect,
  busy = false,
  error = null,
  progress,
  implemented,
  onResume,
}: {
  persona: string;
  /** Every account the Gateway has, with its status (#620), not only the connected ones. */
  connected: readonly ConnectedAccount[];
  onConnect: (type: string, mode: ScopeMode) => void;
  busy?: boolean;
  error?: string | null;
  /** The sign-in under way (#505), under the Connect button. */
  progress?: ReactNode;
  /** Connector types the Gateway can connect (its catalogue); undefined offers every row. */
  implemented?: ReadonlySet<string> | undefined;
  /** Continues an account that is not connected yet: its permission, sign-in or error (#620). */
  onResume?: (account: ConnectedAccount) => void;
}): ReactElement {
  const id = useId();
  // Only real connectors here: MCP servers and Slack are added later in Settings (#529).
  const offered = offeredCatalog(implemented, { navigation: false }).filter(
    (c) => !connected.some((x) => x.type === c.type) && !needsSetup(c.type),
  );
  // "On this Mac" (the Apple apps) and "Accounts" (Google, Microsoft, IMAP), §7.2.
  const macApps = offered
    .filter((c) => isOnThisMac(c.type))
    .sort((a, b) => macOrder(a.type, b.type));
  const available = offered.filter((c) => !isOnThisMac(c.type));
  const [type, setType] = useState<string>(available[0]?.type ?? "");
  const [mode, setMode] = useState<ScopeMode>("read");
  const current = available.some((c) => c.type === type) ? type : (available[0]?.type ?? "");
  // A first run starts with Calendar, Reminders, Mail and Notes selected; derived until the owner
  // changes a box, since the account list may still be loading on the first render.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const selected: ReadonlySet<string> =
    picked ?? new Set(connected.length === 0 ? (DEFAULT_MAC_APPS as readonly string[]) : []);
  const setSelected = (fn: (s: ReadonlySet<string>) => ReadonlySet<string>) =>
    setPicked(fn(selected));
  const chosen = macApps.filter((c) => selected.has(c.type)).map((c) => c.type);
  const queue = useMacQueue({ connected, busy, error, onConnect, mode });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-reading text-label-secondary">
        {t("onboarding.connectors.intro", { name: persona })}
      </p>
      <section aria-labelledby={`${id}-connected`} className="flex flex-col gap-2">
        {/* The step title is the page's h1 (docs/a11y-audit.md L3), so step sections are h2. */}
        <h2 id={`${id}-connected`} className="px-1 text-caption text-label-secondary">
          {/* The count is what is connected; the list also shows accounts still pending (#620). */}
          {t("onboarding.connectors.connected", {
            n: connected.filter((c) => (c.status ?? "connected") === "connected").length,
          })}
        </h2>
        {connected.length > 0 ? (
          <ul
            className="flex flex-col divide-y divide-separator rounded-lg bg-surface-raised shadow-elevation-1"
            aria-label={t("onboarding.connectors.connectedList")}
          >
            {connected.map((c) => (
              <li
                key={c.connectorId ?? c.type}
                className="flex min-h-9 flex-wrap items-center gap-2 px-3 py-1.5 text-body"
              >
                {(c.status ?? "connected") === "connected" ? (
                  <Check className="size-4 text-success-text" aria-hidden="true" />
                ) : (
                  <CircleAlert className="size-4 text-approval-text" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1 text-label-primary">{c.label}</span>
                {(c.status ?? "connected") === "connected" ? (
                  <StatusChip tone="neutral">{SCOPE_MODE_LABEL[c.mode]}</StatusChip>
                ) : (
                  <>
                    <StatusChip tone={c.status === "error" ? "danger" : "approval"}>
                      {c.status === "error"
                        ? t("onboarding.connectors.failed")
                        : c.needs === "permission"
                          ? t("onboarding.connectors.needsPermission")
                          : t("onboarding.connectors.needsSignIn")}
                    </StatusChip>
                    {onResume ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => onResume(c)}
                      >
                        {c.status === "error"
                          ? t("onboarding.connectors.tryAgain", { name: c.label })
                          : c.needs === "permission"
                            ? t("onboarding.connectors.allow", { name: c.label })
                            : t("onboarding.connectors.continue", { name: c.label })}
                      </Button>
                    ) : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-callout text-label-secondary">
            <Plug className="size-4" aria-hidden="true" />
            {t("onboarding.connectors.none")}
          </p>
        )}
      </section>
      {error ? (
        <ErrorNotice what={error} did={t("onboarding.connectors.nothingConnected")} />
      ) : null}
      {offered.length > 0 ? (
        <ConnectAccessChoice
          label={t("onboarding.connectors.what", { name: persona })}
          value={mode}
          onChange={setMode}
          persona={persona}
        />
      ) : null}
      {macApps.length > 0 ? (
        <section aria-labelledby={`${id}-mac`} className="flex flex-col gap-2">
          <h2 id={`${id}-mac`} className="px-1 text-caption text-label-secondary">
            {t("onboarding.connectors.onThisMac")}
          </h2>
          <ul
            aria-labelledby={`${id}-mac`}
            className="flex flex-col divide-y divide-separator rounded-lg bg-surface-raised shadow-elevation-1"
          >
            {macApps.map((c) => (
              <li key={c.type} className="flex min-h-9 items-center gap-2.5 px-3 py-1.5 text-body">
                <Checkbox
                  id={`${id}-${c.type}`}
                  checked={selected.has(c.type)}
                  disabled={queue.running}
                  onCheckedChange={(on) =>
                    setSelected((s) => {
                      const next = new Set(s);
                      if (on) next.add(c.type);
                      else next.delete(c.type);
                      return next;
                    })
                  }
                />
                <Label htmlFor={`${id}-${c.type}`} className="flex-1 font-normal">
                  {c.label}
                </Label>
                {queue.current === c.type ? (
                  <Loader
                    className="size-4 text-label-secondary motion-safe:animate-spin"
                    aria-label={t("onboarding.connectors.connecting", { name: c.label })}
                  />
                ) : null}
              </li>
            ))}
          </ul>
          <p className="px-1 text-callout text-label-secondary">
            {t("onboarding.connectors.onThisMacHint")}
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || queue.running || chosen.length === 0}
              onClick={() => {
                // Keep the choice as made: the defaults no longer apply once one connects.
                setPicked(new Set(chosen));
                queue.start(chosen);
              }}
            >
              {queue.running ? (
                <Loader className="motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {t("onboarding.connectors.connectApps", { n: chosen.length })}
            </Button>
          </div>
        </section>
      ) : null}
      {available.length === 0 ? (
        macApps.length === 0 ? (
          <p className="text-sm">{t("onboarding.connectors.all")}</p>
        ) : null
      ) : (
        <section aria-labelledby={`${id}-accounts`} className="flex flex-col gap-2">
          <h2 id={`${id}-accounts`} className="px-1 text-caption text-label-secondary">
            {t("onboarding.connectors.accounts")}
          </h2>
          <div className="elevation-1 flex flex-col gap-3 rounded-lg p-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-type`}>
                {connected.length === 0
                  ? t("onboarding.connectors.account")
                  : t("onboarding.connectors.another")}
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
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy || queue.running}
                onClick={() => onConnect(current, mode)}
              >
                {busy ? <Loader className="motion-safe:animate-spin" aria-hidden="true" /> : null}
                {t("onboarding.connectors.connect")}
              </Button>
            </div>
          </div>
        </section>
      )}
      {progress}
    </div>
  );
}

/**
 * Connects the selected Mac apps one at a time (§9: never every macOS prompt at once): the next
 * starts once the last one shows up in the account list (connected, or waiting on its grant) and
 * nothing is busy; an error stops the rest.
 */
function useMacQueue({
  connected,
  busy,
  error,
  onConnect,
  mode,
}: {
  connected: readonly ConnectedAccount[];
  busy: boolean;
  error: string | null;
  onConnect: (type: string, mode: ScopeMode) => void;
  mode: ScopeMode;
}): { running: boolean; current: string | null; start: (types: readonly string[]) => void } {
  const [queue, setQueue] = useState<readonly string[]>([]);
  const [requested, setRequested] = useState<string | null>(null);
  const head = queue[0] ?? null;
  const done = head !== null && connected.some((c) => c.type === head);
  useEffect(() => {
    if (head === null || busy) return;
    if (done) {
      setQueue((q) => q.slice(1));
      return;
    }
    if (requested === head) {
      // Asked, not busy, and still not listed: it failed (the error says why); stop here.
      if (error !== null) setQueue([]);
      return;
    }
    setRequested(head);
    onConnect(head, mode);
  }, [head, busy, done, requested, error, onConnect, mode]);
  return {
    running: head !== null,
    current: head,
    start: (types) => {
      setRequested(null);
      setQueue(types);
    },
  };
}

// --- 4 Model & provider ----------------------------------------------------------------------------

export interface ModelOption {
  ref: string;
  label: string;
  hint: string;
}

// i18n-ignore-start: provider and model names are brands, written the same in every language.
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
          get hint() {
            return t("onboarding.model.hint.cloud.anthropicClaudeSonnet55");
          },
        },
        {
          ref: "anthropic/claude-opus-5-5",
          label: "Claude Opus 5.5",
          get hint() {
            return t("onboarding.model.hint.cloud.anthropicClaudeOpus55");
          },
        },
        {
          ref: "anthropic/claude-haiku-5-5",
          label: "Claude Haiku 5.5",
          get hint() {
            return t("onboarding.model.hint.cloud.anthropicClaudeHaiku55");
          },
        },
      ],
    },
    {
      id: "openai",
      label: "OpenAI",
      defaultModel: "openai/gpt-5.5",
      models: [
        {
          ref: "openai/gpt-5.5",
          label: "GPT-5.5",
          get hint() {
            return t("onboarding.model.hint.cloud.openaiGpt55");
          },
        },
        {
          ref: "openai/gpt-5.5-mini",
          label: "GPT-5.5 mini",
          get hint() {
            return t("onboarding.model.hint.cloud.openaiGpt55Mini");
          },
        },
      ],
    },
    {
      id: "google",
      label: "Google",
      defaultModel: "google/gemini-3-pro",
      models: [
        {
          ref: "google/gemini-3-pro",
          label: "Gemini 3 Pro",
          get hint() {
            return t("onboarding.model.hint.cloud.googleGemini3Pro");
          },
        },
        {
          ref: "google/gemini-3-flash",
          label: "Gemini 3 Flash",
          get hint() {
            return t("onboarding.model.hint.cloud.googleGemini3Flash");
          },
        },
      ],
    },
  ],
  // Subscriptions run through the provider's own CLI, signed in on this Mac (claude-code/*,
  // codex/*); the anthropic/* and openai/* API refs would need an API key instead (#537).
  subscription: [
    {
      id: "claude-code",
      get label() {
        return t("onboarding.model.claudeSubscription");
      },
      defaultModel: "claude-code/sonnet",
      models: [
        {
          ref: "claude-code/sonnet",
          label: "Claude Sonnet",
          get hint() {
            return t("onboarding.model.hint.subscription.claudeCodeSonnet");
          },
        },
        {
          ref: "claude-code/opus",
          label: "Claude Opus",
          get hint() {
            return t("onboarding.model.hint.subscription.claudeCodeOpus");
          },
        },
        {
          ref: "claude-code/haiku",
          label: "Claude Haiku",
          get hint() {
            return t("onboarding.model.hint.subscription.claudeCodeHaiku");
          },
        },
        {
          ref: "claude-code/default",
          get label() {
            return t("onboarding.model.cliDefault");
          },
          get hint() {
            return t("onboarding.model.hint.subscription.claudeCodeDefault");
          },
        },
      ],
    },
    {
      id: "codex",
      get label() {
        return t("onboarding.model.chatgptSubscription");
      },
      defaultModel: "codex/default",
      models: [
        {
          ref: "codex/default",
          get label() {
            return t("onboarding.model.cliDefault");
          },
          get hint() {
            return t("onboarding.model.hint.subscription.codexDefault");
          },
        },
      ],
    },
  ],
  openrouter: [
    {
      id: "openrouter",
      label: "OpenRouter",
      defaultModel: "openrouter/auto",
      models: [
        {
          ref: "openrouter/auto",
          get label() {
            return t("onboarding.model.auto");
          },
          get hint() {
            return t("onboarding.model.hint.openrouter.openrouterAuto");
          },
        },
        {
          ref: "openrouter/anthropic/claude-sonnet-5-5",
          label: "Claude Sonnet 5.5",
          get hint() {
            return t("onboarding.model.hint.openrouter.openrouterAnthropicClaudeSonnet55");
          },
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
          get hint() {
            return t("onboarding.model.hint.local.ollamaQwen3827b");
          },
        },
        {
          ref: "ollama/glm-4.7-flash",
          label: "GLM 4.7 Flash",
          get hint() {
            return t("onboarding.model.hint.local.ollamaGlm47Flash");
          },
        },
      ],
    },
    {
      id: "lmstudio",
      label: "LM Studio",
      defaultModel: "lmstudio/gemma4-31b",
      models: [
        {
          ref: "lmstudio/gemma4-31b",
          label: "Gemma 4 31B",
          get hint() {
            return t("onboarding.model.hint.local.lmstudioGemma431b");
          },
        },
      ],
    },
  ],
};
// i18n-ignore-end

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
  keyRefused = false,
  recoveryKey,
  recoverySaved = false,
  onRecoverySaved,
}: {
  value: ModelChoice;
  onChange: (next: ModelChoice) => void;
  ramGb?: number;
  /** Stores the key; when absent the key field explains it can be added later. */
  onSaveKey?: (key: string) => void;
  onCheck?: () => void;
  keyError?: string | null;
  /** The key was stored but the provider refused it (the error already says what to do). */
  keyRefused?: boolean;
  /** The vault's recovery key, when saving the key just created the vault. Shown once. */
  recoveryKey?: string;
  /** The owner confirmed saving it; required before leaving the step. */
  recoverySaved?: boolean;
  onRecoverySaved?: (saved: boolean) => void;
}): ReactElement {
  const id = useId();
  const [key, setKey] = useState("");
  const providers = PROVIDERS[value.kind];
  const models = providers.find((p) => p.id === value.provider)?.models ?? [];
  const [other, setOther] = useState(false);
  const known = models.some((m) => m.ref === value.modelRef);
  const picked = other || !known ? OTHER_MODEL : value.modelRef;
  const needsKey = value.kind === "cloud" || value.kind === "openrouter";
  const clip = useCopy();
  return (
    <div className="flex flex-col gap-4">
      <RadioField
        grouped
        label={t("onboarding.model.how")}
        value={value.kind}
        onChange={(kind) => {
          setOther(false);
          onChange(defaultModelChoice(kind));
        }}
        options={[
          {
            value: "cloud",
            label: t("onboarding.model.kind.cloud"),
            hint: t("onboarding.model.kind.cloudHint"),
          },
          {
            value: "subscription",
            label: t("onboarding.model.kind.subscription"),
            hint: t("onboarding.model.kind.subscriptionHint"),
          },
          {
            value: "openrouter",
            label: "OpenRouter", // i18n-ignore: a brand name
            hint: t("onboarding.model.kind.openrouterHint"),
          },
          {
            value: "local",
            label: t("onboarding.model.kind.local"),
            hint: t("onboarding.model.kind.localHint"),
          },
        ]}
      />
      {providers.length > 1 ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-provider`}>{t("onboarding.model.provider")}</Label>
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
        grouped
        label={t("onboarding.model.model")}
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
            label: t("onboarding.model.another"),
            hint: t("onboarding.model.anotherHint"),
          },
        ]}
      >
        {picked === OTHER_MODEL ? (
          <div className="ms-6 flex flex-col gap-1">
            <Label htmlFor={`${id}-model`} className="sr-only">
              {t("onboarding.model.modelId")}
            </Label>
            <Input
              id={`${id}-model`}
              className="max-w-sm"
              placeholder={t("onboarding.model.idPlaceholder", { provider: value.provider })}
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
            <KeyRound className="size-3.5" aria-hidden="true" /> {t("onboarding.model.apiKey")}
          </Label>
          {value.keyRef ? (
            <p className="text-sm" role="status">
              {t("onboarding.model.storedAs")} <code className="font-mono">{value.keyRef}</code>
              {t("onboarding.model.neverSees")}
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
                    {t("onboarding.model.saveToVault")}
                  </Button>
                ) : null}
              </div>
              <p id={`${id}-key-hint`} className="text-callout text-label-secondary">
                {onSaveKey ? t("onboarding.model.keyHint") : t("onboarding.model.keyLater")}
              </p>
            </>
          )}
          {keyError ? (
            <ErrorNotice
              what={keyError}
              did={keyRefused ? "" : t("onboarding.model.keyNotStored")}
            />
          ) : null}
          {recoveryKey ? (
            <div
              className="mt-2 flex flex-col gap-1 rounded-lg border border-approval-border bg-approval-surface p-3"
              data-testid="vault-recovery-key"
            >
              <p className="text-headline text-label-primary">
                {t("onboarding.model.recoveryTitle")}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-sm break-all select-all">{recoveryKey}</code>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => void clip.copy(recoveryKey)}
                >
                  {clip.state === "copied" ? <Check aria-hidden="true" /> : null}
                  {clip.state === "copied"
                    ? t("onboarding.model.copied")
                    : t("onboarding.model.copy")}
                </Button>
                <span role="status" className="sr-only">
                  {clip.state === "copied" ? t("onboarding.model.copiedStatus") : ""}
                </span>
                {clip.state === "failed" ? (
                  <span className="text-xs text-danger-text" role="alert">
                    {t("onboarding.model.copyFailed")}
                  </span>
                ) : null}
              </div>
              <p className="text-callout text-label-secondary">
                {t("onboarding.model.recoveryBody")}
              </p>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={recoverySaved}
                  onChange={(e) => onRecoverySaved?.(e.target.checked)}
                />
                {t("onboarding.model.savedIt")}
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {value.kind === "subscription" ? (
        <p className="text-reading text-label-secondary">
          {t("onboarding.model.subscriptionNote")}
        </p>
      ) : null}

      {value.kind === "local" ? <RamGuidance {...(ramGb === undefined ? {} : { ramGb })} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-headline text-label-primary">{t("onboarding.model.toolCheck")}</span>
        <ToolCheckBadge status={value.toolCheck} />
        {onCheck && value.toolCheck !== "running" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={onCheck}
            disabled={value.modelRef.trim() === "" || (needsKey && value.keyRef === null)}
          >
            {value.toolCheck === "untested"
              ? t("onboarding.model.runCheck")
              : t("onboarding.model.checkAgain")}
          </Button>
        ) : null}
      </div>
      {value.toolCheck === "failed" ? (
        <p className="text-sm text-approval-text">{t("onboarding.model.toolCheckFailed")}</p>
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
        grouped
        label={t("onboarding.where.question", { name: persona })}
        value={value}
        onChange={onChange}
        options={[
          {
            value: "local",
            label: t("onboarding.where.local"),
            hint: t("onboarding.where.localHint", { name: persona }),
          },
          {
            value: "vm",
            label: t("onboarding.where.vm"),
            disabled: !vmAvailable,
            hint: vmAvailable
              ? t("onboarding.where.vmHint", { name: persona })
              : t("onboarding.where.vmUnavailable"),
          },
        ]}
      />
      <div className="rounded-lg bg-surface-raised p-4 text-body shadow-elevation-1">
        <h2 className="mb-2 font-semibold">
          {value === "vm" ? t("onboarding.where.vmDefaults") : t("onboarding.where.localDefaults")}
        </h2>
        {value === "vm" ? (
          <Facts
            items={[
              { term: t("onboarding.where.vm.guest"), value: t("onboarding.where.vm.guestValue") },
              { term: t("onboarding.where.vm.sees"), value: t("onboarding.where.vm.seesValue") },
              {
                term: t("onboarding.where.vm.cantSee"),
                value: t("onboarding.where.vm.cantSeeValue"),
              },
              { term: t("onboarding.where.vm.watch"), value: t("onboarding.where.vm.watchValue") },
            ]}
          />
        ) : (
          <Facts
            items={[
              {
                term: t("onboarding.where.local.apps"),
                value: t("onboarding.where.local.appsValue"),
              },
              {
                term: t("onboarding.where.local.files"),
                value: t("onboarding.where.local.filesValue"),
              },
              {
                term: t("onboarding.where.local.commands"),
                value: t("onboarding.where.local.commandsValue"),
              },
              {
                term: t("onboarding.where.local.stop"),
                value: t("onboarding.where.local.stopValue"),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}

// --- 6 Done ----------------------------------------------------------------------------------------

const CHECK_TONE = { ok: "success", warn: "approval" } as const;

export function DoneStep({
  result,
  checks,
  permissionsOnMac = false,
}: {
  result: OnboardingResult;
  /** This window can't ask macOS: say the permissions are set up in the desktop app (#554). */
  permissionsOnMac?: boolean;
  /** What `onVerify` found; "checking" while it runs. */
  checks?: SetupCheck[] | "checking";
}): ReactElement {
  const p = result.persona;
  const granted = (Object.entries(result.permissions) as [TccPermission, PermissionAnswer][])
    .filter(([, a]) => a === "granted")
    .map(([k]) => TCC_LABEL[k].name);
  return (
    <div className="flex flex-col items-start gap-4">
      <div className="flex items-center gap-4">
        <Avatar name={p.name} creature={p.creatureId} size={64} />
        <div>
          <p className="text-lg font-semibold">{t("onboarding.done.ready", { name: p.name })}</p>
          <p className="text-reading text-label-secondary">
            {t("onboarding.done.opens", { name: p.name })}
          </p>
        </div>
      </div>
      <Facts
        className="text-sm"
        items={[
          { term: t("onboarding.done.tagline"), value: p.tagline || t("onboarding.done.none") },
          {
            term: t("onboarding.done.permissions"),
            value: permissionsOnMac
              ? t("onboarding.done.permissionsOnMac")
              : granted.length > 0
                ? activeI18n().list(granted)
                : t("onboarding.done.noneYet"),
          },
          {
            term: t("onboarding.done.accounts"),
            value:
              result.connectors.length > 0
                ? activeI18n().list(
                    result.connectors.map((c) =>
                      t("onboarding.done.account", {
                        label: c.label,
                        mode: SCOPE_MODE_LABEL[c.mode].toLocaleLowerCase(
                          activeI18n().messageLocale,
                        ),
                      }),
                    ),
                  )
                : t("onboarding.done.noneYet"),
          },
          {
            term: t("onboarding.done.model"),
            value: (
              <span className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{result.model.modelRef}</code>
                <ToolCheckBadge status={result.model.toolCheck} />
              </span>
            ),
          },
          {
            term: t("onboarding.done.worksIn"),
            value:
              result.workspace === "vm" ? t("onboarding.done.vmMode") : t("onboarding.where.local"),
          },
        ]}
      />
      {checks === "checking" ? (
        <p className="flex items-center gap-2 text-callout text-label-secondary" role="status">
          <Loader className="size-4 motion-safe:animate-spin" aria-hidden="true" />{" "}
          {t("onboarding.done.checking")}
        </p>
      ) : checks ? (
        <ul
          className="flex w-full flex-col gap-2"
          aria-label={t("onboarding.done.checks")}
          data-testid="setup-checks"
        >
          {checks.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
              <StatusChip tone={CHECK_TONE[c.state]}>
                {c.state === "ok" ? t("onboarding.done.ok") : t("onboarding.done.check")}
              </StatusChip>
              <span className="font-medium">{c.label}</span>
              <span className="text-muted-foreground">{c.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
