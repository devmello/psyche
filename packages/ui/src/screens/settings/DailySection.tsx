import type {
  Automation,
  DailyAutomationDraft,
  DailyAutomationTemplate,
  DailyFollowup,
} from "@psyche/protocol";
import { type ReactElement, type ReactNode, useCallback, useState } from "react";
import { toast } from "sonner";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useCall, useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { useSlots } from "../../slots.tsx";
import { AutomationDraftCard } from "../scheduled/AutomationDraftCard.tsx";
import { TimeRow } from "./MailMeetingsSection.tsx";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  SectionFrame,
  type SettingsFormProps,
  SwitchField,
  str,
  useSettingsForm,
} from "./shared.tsx";

/**
 * Settings → Daily. The keys, which the onboarding "Turn on habits" step also writes with
 * `settings.set`: `daily.brief.enabled`, `daily.brief.time` ("08:00"), `daily.wrapup.enabled`,
 * `daily.wrapup.time` ("18:00"), `daily.notify`, `daily.messages`, `daily.followups.enabled`
 * and `daily.followups.sensitivity` ("low" | "normal" | "high"). Jobs read them per run.
 */
export const DAILY_DEFAULTS = {
  "daily.brief.enabled": false,
  "daily.brief.time": "08:00",
  "daily.wrapup.enabled": false,
  "daily.wrapup.time": "18:00",
  "daily.notify": true,
  "daily.messages": false,
  "daily.followups.enabled": true,
  "daily.followups.sensitivity": "normal",
} as const;

const SENSITIVITIES = ["low", "normal", "high"] as const;

export interface FollowupsListProps {
  followups: readonly DailyFollowup[];
  onUpdate: (id: string, action: "done" | "snooze" | "dismiss" | "reopen") => void;
  onOpen?: (link: string) => void;
}

/** The Follow-ups view: what Psyche tracks, with done, snooze and dismiss on each row. */
export function FollowupsList({ followups, onUpdate, onOpen }: FollowupsListProps): ReactElement {
  if (followups.length === 0) {
    return <p className="text-callout text-label-secondary">{t("daily.followups.empty")}</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-separator" aria-label={t("daily.followups.title")}>
      {followups.map((f) => (
        <li key={f.id} className="flex flex-wrap items-center gap-2 py-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-body text-label-primary">{f.text}</span>
            <span className="text-caption text-label-secondary">
              {t(`daily.followups.source.${f.source}`)}
              {f.sourceLink && onOpen ? (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="cursor-default text-accent-11 hover:underline"
                    onClick={() => onOpen(f.sourceLink as string)}
                  >
                    {t("daily.item.open", { item: t(`daily.followups.source.${f.source}`) })}
                  </button>
                </>
              ) : null}
            </span>
          </div>
          <div className="flex shrink-0 gap-1">
            {(["done", "snooze", "dismiss"] as const).map((a) => (
              <Button
                key={a}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onUpdate(f.id, a)}
              >
                {t(`daily.followup.${a}`)}
              </Button>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface AutomationsPanelProps {
  automations: readonly Automation[];
  templates: readonly DailyAutomationTemplate[];
  /** The draft awaiting confirmation (the confirmation card), or null. */
  draft: DailyAutomationDraft | null;
  parseError?: string | null;
  busy?: boolean;
  onParse: (text: string) => void;
  onConfirm: () => void;
  onCancelDraft: () => void;
  onToggle: (a: Automation) => void;
  onEdit: (a: Automation, patch: { title?: string; prompt?: string }) => void;
  onDelete: (a: Automation) => void;
  /**
   * When the host has the Scheduled screen, the list lives there: this panel keeps the "describe
   * it" box and links to the list instead of repeating it.
   */
  onOpenScheduled?: () => void;
}

/** Plain-language automations: type a sentence, confirm the card, manage the list. */
export function AutomationsPanel({
  automations,
  templates,
  draft,
  parseError = null,
  busy = false,
  onParse,
  onConfirm,
  onCancelDraft,
  onToggle,
  onEdit,
  onDelete,
  onOpenScheduled,
}: AutomationsPanelProps): ReactElement {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  return (
    <div className="flex flex-col gap-3">
      <p className="text-callout text-label-secondary">{t("daily.automations.description")}</p>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() !== "") onParse(text.trim());
        }}
      >
        <Input
          aria-label={t("daily.automations.input")}
          placeholder={t("daily.automations.placeholder")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Button type="submit" disabled={busy || text.trim() === ""}>
          {t("daily.automations.create")}
        </Button>
      </form>
      {templates.length > 0 && draft === null ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-caption text-label-secondary">
            {t("daily.automations.templates")}
          </span>
          {templates.map((tpl) => (
            <Button
              key={tpl.id}
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setText(tpl.text)}
            >
              {tpl.text}
            </Button>
          ))}
        </div>
      ) : null}
      {parseError ? (
        <p role="alert" className="text-callout text-destructive">
          {parseError}
        </p>
      ) : null}
      {draft ? (
        <AutomationDraftCard
          draft={draft}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancelDraft}
        />
      ) : null}
      {onOpenScheduled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-callout text-label-secondary">
            {t("daily.automations.count", { n: automations.length })}
          </span>
          <Button type="button" size="sm" variant="secondary" onClick={onOpenScheduled}>
            {t("daily.automations.manage")}
          </Button>
        </div>
      ) : automations.length === 0 ? (
        <p className="text-callout text-label-secondary">{t("daily.automations.empty")}</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-separator"
          aria-label={t("daily.automations.title")}
        >
          {automations.map((a) => (
            <li key={a.id} className="flex flex-col gap-2 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body text-label-primary">
                    {a.title}
                    {a.enabled ? null : (
                      <span className="ml-2 text-caption text-label-secondary">
                        {t("daily.automations.paused")}
                      </span>
                    )}
                  </span>
                  <span className="text-caption text-label-secondary">{a.schedule}</span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button type="button" size="sm" variant="ghost" onClick={() => onToggle(a)}>
                    {a.enabled ? t("daily.automations.pause") : t("daily.automations.resume")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditing(editing === a.id ? null : a.id);
                      setPrompt(a.prompt);
                    }}
                  >
                    {t("daily.automations.edit")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => onDelete(a)}>
                    {t("daily.automations.delete")}
                  </Button>
                </div>
              </div>
              {editing === a.id ? (
                <form
                  className="flex flex-wrap items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onEdit(a, { prompt });
                    setEditing(null);
                  }}
                >
                  <Input
                    aria-label={t("daily.automations.confirm.does")}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="min-w-0 flex-1"
                  />
                  <Button type="submit" size="sm">
                    {t("daily.automations.save")}
                  </Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface DailyPanelProps extends Pick<SettingsFormProps, "values" | "onChange"> {
  needsApproval?: ReadonlySet<string>;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onPreview?: (kind: "morning" | "evening") => void;
  children?: ReactNode;
}

const flag = (v: SettingsFormProps["values"], key: keyof typeof DAILY_DEFAULTS & `${string}`) =>
  bool(v, key, DAILY_DEFAULTS[key] as boolean);

/** The presentational Settings → Daily page; the follow-ups and automations are its children. */
export function DailyPanel({
  values,
  onChange,
  needsApproval,
  loading = false,
  error = null,
  onRetry,
  onPreview,
  children,
}: DailyPanelProps): ReactElement {
  const briefOn = flag(values, "daily.brief.enabled");
  const wrapupOn = flag(values, "daily.wrapup.enabled");
  const followupsOn = flag(values, "daily.followups.enabled");
  const sens = str(
    values,
    "daily.followups.sensitivity",
    DAILY_DEFAULTS["daily.followups.sensitivity"],
  );
  return (
    <SectionFrame
      title={t("settings.daily.title")}
      description={t("settings.daily.description")}
      needsApproval={needsApproval}
    >
      <LoadGate
        label={t("settings.daily.title")}
        loading={loading}
        error={error}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.daily.group.brief")}>
          <SwitchField
            label={t("settings.key.daily.brief.enabled")}
            settingKey="daily.brief.enabled"
            checked={briefOn}
            onChange={(v) => onChange("daily.brief.enabled", v)}
          />
          <TimeRow
            label={t("settings.daily.time")}
            value={str(values, "daily.brief.time", DAILY_DEFAULTS["daily.brief.time"])}
            disabled={!briefOn}
            onCommit={(v) => onChange("daily.brief.time", v)}
          />
          {onPreview ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onPreview("morning")}
            >
              {t("settings.daily.runNow")}
            </Button>
          ) : null}
        </Group>
        <Group title={t("settings.daily.group.wrapup")}>
          <SwitchField
            label={t("settings.key.daily.wrapup.enabled")}
            settingKey="daily.wrapup.enabled"
            checked={wrapupOn}
            onChange={(v) => onChange("daily.wrapup.enabled", v)}
          />
          <TimeRow
            label={t("settings.daily.time")}
            value={str(values, "daily.wrapup.time", DAILY_DEFAULTS["daily.wrapup.time"])}
            disabled={!wrapupOn}
            onCommit={(v) => onChange("daily.wrapup.time", v)}
          />
          {onPreview ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onPreview("evening")}
            >
              {t("settings.daily.runNow")}
            </Button>
          ) : null}
        </Group>
        <Group title={t("settings.daily.group.delivery")}>
          <SwitchField
            label={t("settings.key.daily.notify")}
            description={t("settings.daily.notify.hint")}
            settingKey="daily.notify"
            checked={flag(values, "daily.notify")}
            onChange={(v) => onChange("daily.notify", v)}
          />
          <SwitchField
            label={t("settings.key.daily.messages")}
            description={t("settings.daily.messages.hint")}
            settingKey="daily.messages"
            checked={flag(values, "daily.messages")}
            onChange={(v) => onChange("daily.messages", v)}
          />
        </Group>
        <Group title={t("settings.daily.group.followups")}>
          <SwitchField
            label={t("settings.key.daily.followups.enabled")}
            settingKey="daily.followups.enabled"
            checked={followupsOn}
            onChange={(v) => onChange("daily.followups.enabled", v)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <label
              htmlFor="daily-sensitivity"
              className="min-w-0 flex-1 text-body text-label-primary"
            >
              {t("settings.daily.sensitivity")}
            </label>
            <NativeSelect
              id="daily-sensitivity"
              value={sens}
              disabled={!followupsOn}
              onChange={(e) => onChange("daily.followups.sensitivity", e.target.value)}
            >
              {SENSITIVITIES.map((s) => (
                <option key={s} value={s}>
                  {t(`settings.daily.sensitivity.${s}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
        </Group>
        {children}
      </LoadGate>
    </SectionFrame>
  );
}

const isUserAutomation = (a: Automation) =>
  (a.kind === "cron" || a.kind === "interval") && !a.prompt.trimStart().startsWith("[psyche:");

/** Settings → Daily, wired to the Gateway. */
export function DailySection(): ReactElement {
  const form = useSettingsForm();
  const call = useCall();
  const { navigate } = useSlots();
  const followups = useGatewayQuery("daily.followups.list", {});
  const autos = useGatewayQuery("automations.list", {});
  const templates = useGatewayQuery("daily.automations.templates", {});
  const [draft, setDraft] = useState<DailyAutomationDraft | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { reload: reloadFollowups } = followups;
  const { reload: reloadAutos } = autos;
  const fail = useCallback((key: Parameters<typeof t>[0], err: unknown) => {
    toast.error(`${t(key)} ${describeError(err)}`);
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <DailyPanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        onPreview={(kind) =>
          void call("daily.run", { kind }).catch((err: unknown) =>
            fail("settings.daily.runFailed", err),
          )
        }
      >
        <Group title={t("daily.followups.title")}>
          <FollowupsList
            followups={followups.data?.followups ?? []}
            onUpdate={(id, action) =>
              void call("daily.followups.update", { id, action })
                .then(() => reloadFollowups())
                .catch((err: unknown) => fail("daily.followup.failed", err))
            }
          />
        </Group>
        <Group title={t("settings.daily.group.automations")}>
          <AutomationsPanel
            automations={(autos.data?.automations ?? []).filter(isUserAutomation)}
            templates={templates.data?.templates ?? []}
            draft={draft}
            parseError={parseError}
            busy={busy}
            onParse={(text) => {
              setBusy(true);
              setParseError(null);
              call("daily.automations.parse", { text })
                .then((r) => {
                  if (r.draft) setDraft(r.draft);
                  else
                    setParseError(
                      r.error === "no_model"
                        ? t("daily.automations.noModel")
                        : t("daily.automations.parseFailed"),
                    );
                })
                .catch((err: unknown) => setParseError(describeError(err)))
                .finally(() => setBusy(false));
            }}
            onConfirm={() => {
              if (!draft) return;
              setBusy(true);
              call("daily.automations.confirm", { draft })
                .then(() => {
                  setDraft(null);
                  toast.success(t("daily.automations.created"));
                  reloadAutos();
                })
                .catch((err: unknown) => fail("daily.automations.createFailed", err))
                .finally(() => setBusy(false));
            }}
            onCancelDraft={() => setDraft(null)}
            onToggle={(a) =>
              void call("automations.update", { automationId: a.id, enabled: !a.enabled })
                .then(() => reloadAutos())
                .catch((err: unknown) => fail("daily.automations.failed", err))
            }
            onEdit={(a, patch) =>
              void call("automations.update", { automationId: a.id, ...patch })
                .then(() => reloadAutos())
                .catch((err: unknown) => fail("daily.automations.failed", err))
            }
            onDelete={(a) =>
              void call("automations.delete", { automationId: a.id })
                .then(() => reloadAutos())
                .catch((err: unknown) => fail("daily.automations.failed", err))
            }
            {...(navigate ? { onOpenScheduled: () => navigate("/scheduled") } : {})}
          />
        </Group>
      </DailyPanel>
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
