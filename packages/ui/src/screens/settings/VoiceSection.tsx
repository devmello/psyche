import { type ReactElement, useEffect, useId, useRef } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
import { NativeSelect } from "../../components/ui/native-select.tsx";
import { useGatewayQuery } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { migrateVoiceSettings, readVoiceSettings, VOICE_RATE } from "../../voice/settings.ts";
import { type ShortcutCheck, ShortcutRecorder } from "./ShortcutRecorder.tsx";
import {
  bool,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  RadioField,
  SectionFrame,
  type SettingsFormProps,
  StatusChip,
  SwitchField,
  str,
  useSettingsForm,
} from "./shared.tsx";

/** Voice & dictation (UI design §3.18): push-to-talk key, toggle mode, global hotkey, engine. */

/**
 * What the desktop's system-wide dictation sees right now (features J9, Q2). `accessibility` is
 * the Psyche helper's grant as the hold-to-talk watch found it; `hotkeyTaken` names a toggle
 * hotkey another app already owns.
 */
export interface SystemDictationStatus {
  helper: "online" | "offline";
  accessibility: "granted" | "missing" | "unknown";
  watching: boolean;
  hotkeyTaken?: string;
}

export interface SystemDictationProps {
  /** Desktop only; absent on the web, where system-wide dictation does not exist. */
  system?: SystemDictationStatus | null;
  /** Opens System Settings › Privacy & Security › Accessibility. */
  onOpenAccessibility?: () => void;
  /** Re-arms the watch after the owner granted Accessibility. */
  onRecheck?: () => void;
  /** Desktop: asks main whether another app holds a shortcut before it is saved. */
  onCheckShortcut?: (accelerator: string) => Promise<ShortcutCheck>;
  /** Desktop: the same check for the Ask about screen shortcut. */
  onCheckScreenShortcut?: (accelerator: string) => Promise<ShortcutCheck>;
}

/** Ask about my screen (docs/design/screen-ask-2026.md §6): desktop only. */
export function ScreenAskGroup({
  values,
  onChange,
  onCheck,
}: Pick<SettingsFormProps, "values" | "onChange"> & {
  onCheck?: (accelerator: string) => Promise<ShortcutCheck>;
}): ReactElement {
  const enabled = bool(values, "screenAsk.enabled", true);
  return (
    <Group title={t("settings.screenAsk.title")}>
      <SwitchField
        label={t("settings.key.screenAsk.enabled")}
        description={t("settings.screenAsk.enabledHint")}
        checked={enabled}
        settingKey="screenAsk.enabled"
        onChange={(on) => onChange("screenAsk.enabled", on)}
      />
      {enabled ? (
        <>
          <ShortcutRecorder
            label={t("settings.key.screenAsk.shortcut")}
            description={t("settings.screenAsk.shortcutHint")}
            value={str(values, "screenAsk.shortcut", "Alt+Shift+Space")}
            onChange={(v) => onChange("screenAsk.shortcut", v)}
            {...(onCheck ? { onCheck } : {})}
          />
          <RadioField
            label={t("settings.key.screenAsk.destination")}
            inline
            value={str(values, "screenAsk.destination", "new")}
            settingKey="screenAsk.destination"
            onChange={(v) => onChange("screenAsk.destination", v)}
            options={[
              { value: "new", label: t("screenAsk.dest.new") },
              { value: "current", label: t("screenAsk.dest.current") },
            ]}
          />
          <SwitchField
            label={t("settings.key.screenAsk.alwaysImage")}
            description={t("settings.screenAsk.alwaysImageHint")}
            checked={bool(values, "screenAsk.alwaysImage", false)}
            settingKey="screenAsk.alwaysImage"
            onChange={(on) => onChange("screenAsk.alwaysImage", on)}
          />
        </>
      ) : null}
    </Group>
  );
}

const PTT_KEYS = ["fn", "rightOption", "rightCommand"] as const;

/** The push-to-talk key as printed or named on a Mac keyboard; an unknown key shows as stored. */
function keyLabel(key: string): string {
  const known = PTT_KEYS.find((k) => k === key);
  return known === undefined ? key : t(`settings.voice.key.${known}`);
}

function AccessibilityRow({
  status,
  onOpenAccessibility,
  onRecheck,
}: {
  status: SystemDictationStatus;
  onOpenAccessibility?: () => void;
  onRecheck?: () => void;
}): ReactElement {
  const chip =
    status.helper === "offline"
      ? { tone: "neutral" as const, text: t("settings.voice.access.helperOff") }
      : status.accessibility === "granted"
        ? { tone: "success" as const, text: t("settings.computerUse.tccState.granted") }
        : status.accessibility === "missing"
          ? { tone: "danger" as const, text: t("settings.voice.access.needed") }
          : { tone: "neutral" as const, text: t("settings.voice.access.unknown") };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">{t("settings.computerUse.tcc.accessibility.name")}</span>
      <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
      <span className="text-xs text-muted-foreground">{t("settings.voice.access.why")}</span>
      {status.helper === "online" && status.accessibility !== "granted" ? (
        <span className="ms-auto flex gap-2">
          {onOpenAccessibility ? (
            <Button type="button" variant="outline" size="xs" onClick={onOpenAccessibility}>
              {t("settings.computerUse.openSystemSettings")}
            </Button>
          ) : null}
          {onRecheck ? (
            <Button type="button" variant="ghost" size="xs" onClick={onRecheck}>
              {t("settings.model.checkAgain")}
            </Button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

/** The voices `speech.voices` lists, for the Voice row (null while unknown). */
export interface VoiceChoices {
  voices?: { ref: string; name: string; local: boolean; engine: string }[] | null;
  /** Opens System Settings → Accessibility → Spoken Content (premium voices). */
  onGetVoices?: () => void;
}

const LANGUAGES = ["en", "ar", "de", "es", "fr", "hi", "it", "ja", "ko", "pt", "zh"] as const;

function languageName(code: string): string {
  try {
    return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Settings → Voice & dictation → Voice conversation (docs/voice/voice-mode-2026.md §6.4): talk
 * with Psyche, the voice key (never the dictation key), how turns end, the voice and its speed,
 * how much is spoken and narrated, interrupting, approving by voice, language, captions, review
 * before sending, and the spoken brief. Replaces #481's Q5 group; its keys are migrated.
 */
export function VoiceConversationGroup({
  values,
  onChange,
  voices,
  onGetVoices,
}: Pick<SettingsFormProps, "values" | "onChange"> & VoiceChoices): ReactElement {
  const v = readVoiceSettings(values);
  const dictationKey = str(values, "voice.pushToTalk", "fn");
  const rateId = useId();
  const voiceId = useId();
  const languageId = useId();
  return (
    <Group title={t("voice.settings.title")}>
      <SwitchField
        label={t("voice.settings.enabled")}
        description={t("voice.settings.enabledHint")}
        checked={v.enabled}
        settingKey="voice.conversation.enabled"
        onChange={(on) => onChange("voice.conversation.enabled", on)}
      />
      {v.enabled ? (
        <>
          <RadioField
            label={t("voice.settings.key")}
            description={
              v.key === dictationKey ? t("voice.settings.keyClash") : t("voice.settings.keyHint")
            }
            inline
            value={v.key}
            settingKey="voice.conversation.key"
            onChange={(k) => onChange("voice.conversation.key", k)}
            options={(["fn", "rightOption", "rightCommand"] as const).map((k) => ({
              value: k,
              label: t(`voice.key.${k}`),
              disabled: k === dictationKey,
            }))}
          />
          <RadioField
            label={t("voice.settings.mode")}
            value={v.mode}
            settingKey="voice.conversation.mode"
            onChange={(mode) => onChange("voice.conversation.mode", mode)}
            options={(["push", "tap", "handsfree"] as const).map((mode) => ({
              value: mode,
              label: t(`voice.settings.mode.${mode}`),
              hint: t(`voice.settings.mode.${mode}Hint`),
            }))}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={voiceId} className="text-body">
              {t("voice.settings.voice")}
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect
                id={voiceId}
                value={v.voice ?? ""}
                onChange={(e) => onChange("voice.conversation.voice", e.target.value || null)}
                className="min-w-56"
              >
                <option value="">{t("voice.settings.voiceBest")}</option>
                {(voices ?? []).map((o) => (
                  <option key={o.ref} value={o.ref}>
                    {o.local
                      ? o.name
                      : `${o.name} · ${t("voice.settings.voiceCloud", { vendor: o.engine })}`}
                  </option>
                ))}
              </NativeSelect>
              {onGetVoices ? (
                <Button size="sm" variant="ghost" onClick={onGetVoices}>
                  {t("voice.settings.getVoices")}
                </Button>
              ) : null}
            </div>
            {voices === null ? (
              <p className="text-callout text-label-secondary">
                {t("voice.settings.voicesUnavailable")}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={rateId} className="text-body">
              {t("voice.settings.rate")}
            </label>
            <div className="flex items-center gap-3">
              <input
                id={rateId}
                type="range"
                min={VOICE_RATE.min}
                max={VOICE_RATE.max}
                step={VOICE_RATE.step}
                value={v.rate}
                onChange={(e) => onChange("voice.conversation.rate", Number(e.target.value))}
                className="w-48 accent-(--accent-9)"
              />
              <output htmlFor={rateId} className="text-callout text-label-secondary tabular-nums">
                {t("voice.settings.rateValue", { rate: v.rate.toFixed(2).replace(/0$/, "") })}
              </output>
            </div>
          </div>
          <RadioField
            label={t("voice.settings.speak")}
            value={v.speak}
            settingKey="voice.conversation.speak"
            onChange={(x) => onChange("voice.conversation.speak", x)}
            options={(["brief", "full"] as const).map((x) => ({
              value: x,
              label: t(`voice.settings.speak.${x}`),
              hint: t(`voice.settings.speak.${x}Hint`),
            }))}
          />
          <RadioField
            label={t("voice.settings.narrate")}
            inline
            value={v.narrate}
            settingKey="voice.conversation.narrate"
            onChange={(x) => onChange("voice.conversation.narrate", x)}
            options={(["off", "brief", "steps"] as const).map((x) => ({
              value: x,
              label: t(`voice.settings.narrate.${x}`),
            }))}
          />
          <SwitchField
            label={t("voice.settings.bargeIn")}
            description={t("voice.settings.bargeInHint")}
            checked={v.bargeIn}
            settingKey="voice.conversation.bargeIn"
            onChange={(on) => onChange("voice.conversation.bargeIn", on)}
          />
          <RadioField
            label={t("voice.settings.approvals")}
            description={t("voice.settings.approvalsHint")}
            inline
            value={v.approvals}
            settingKey="voice.conversation.approvals"
            onChange={(x) => onChange("voice.conversation.approvals", x)}
            options={(["off", "write", "write_destructive"] as const).map((x) => ({
              value: x,
              label: t(`voice.settings.approvals.${x}`),
            }))}
          />
          <div className="flex flex-col gap-1">
            <label htmlFor={languageId} className="text-body">
              {t("voice.settings.language")}
            </label>
            <NativeSelect
              id={languageId}
              value={v.language ?? ""}
              onChange={(e) => onChange("voice.conversation.language", e.target.value || null)}
              className="min-w-56"
            >
              <option value="">{t("voice.settings.languageFollow")}</option>
              {LANGUAGES.map((code) => (
                <option key={code} value={code}>
                  {languageName(code)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <SwitchField
            label={t("voice.settings.captions")}
            checked={v.captions}
            settingKey="voice.conversation.captions"
            onChange={(on) => onChange("voice.conversation.captions", on)}
          />
          <SwitchField
            label={t("voice.settings.review")}
            description={t("voice.settings.reviewHint")}
            checked={v.reviewBeforeSend}
            settingKey="voice.conversation.reviewBeforeSend"
            onChange={(on) => onChange("voice.conversation.reviewBeforeSend", on)}
          />
          <RadioField
            label={t("voice.settings.brief")}
            value={v.brief}
            settingKey="voice.conversation.brief"
            onChange={(x) => onChange("voice.conversation.brief", x)}
            options={(["off", "listen", "atMac"] as const).map((x) => ({
              value: x,
              label: t(`voice.settings.brief.${x}`),
            }))}
          />
        </>
      ) : null}
    </Group>
  );
}

export function VoicePanel({
  values,
  onChange,
  needsApproval,
  loading,
  error,
  onRetry,
  system,
  onOpenAccessibility,
  onRecheck,
  onCheckShortcut,
  onCheckScreenShortcut,
  voices,
  onGetVoices,
}: SettingsFormProps & LoadProps & SystemDictationProps & VoiceChoices): ReactElement {
  const ptt = str(values, "voice.pushToTalk", "fn");
  const systemWide = bool(values, "voice.systemWide", true);
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.nav.voice")}
      description={
        <>
          {t("settings.voice.hold")} <Kbd>{keyLabel(ptt)}</Kbd> {t("settings.voice.toDictate")}
        </>
      }
    >
      <LoadGate
        label={t("settings.voice.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title={t("settings.voice.dictation")}>
          <RadioField
            label={t("settings.key.voice.pushToTalk")}
            inline
            value={ptt}
            settingKey="voice.pushToTalk"
            onChange={(v) => onChange("voice.pushToTalk", v)}
            options={[
              { value: "fn", label: keyLabel("fn") },
              { value: "rightOption", label: keyLabel("rightOption") },
              { value: "rightCommand", label: keyLabel("rightCommand") },
            ]}
          />
          <RadioField
            label={t("settings.voice.mode")}
            inline
            value={str(values, "voice.mode", "hold")}
            settingKey="voice.mode"
            onChange={(v) => onChange("voice.mode", v)}
            options={[
              { value: "hold", label: t("settings.voice.mode.hold") },
              { value: "toggle", label: t("settings.voice.mode.toggle") },
            ]}
          />
        </Group>
        {system ? (
          <Group title={t("settings.voice.anyApp")}>
            <SwitchField
              label={t("settings.key.voice.systemWide")}
              description={
                <>
                  {t("settings.voice.hold")} <Kbd>{keyLabel(ptt)}</Kbd>{" "}
                  {t("settings.voice.anyAppHint")}
                </>
              }
              checked={systemWide}
              settingKey="voice.systemWide"
              onChange={(v) => onChange("voice.systemWide", v)}
            />
            <AccessibilityRow
              status={system}
              {...(onOpenAccessibility ? { onOpenAccessibility } : {})}
              {...(onRecheck ? { onRecheck } : {})}
            />
            <ShortcutRecorder
              label={t("settings.key.voice.hotkey")}
              description={t("settings.voice.hotkeyHint")}
              value={str(values, "voice.hotkey", "")}
              onChange={(v) => onChange("voice.hotkey", v)}
              {...(onCheckShortcut ? { onCheck: onCheckShortcut } : {})}
              {...(system.hotkeyTaken ? { takenNow: system.hotkeyTaken } : {})}
            />
          </Group>
        ) : null}
        {system ? (
          <ScreenAskGroup
            values={values}
            onChange={onChange}
            {...(onCheckScreenShortcut ? { onCheck: onCheckScreenShortcut } : {})}
          />
        ) : null}
        <VoiceConversationGroup
          values={values}
          onChange={onChange}
          {...(voices ? { voices } : {})}
          {...(onGetVoices ? { onGetVoices } : {})}
        />
        <Group title={t("settings.voice.engine")}>
          <RadioField
            label={t("settings.key.voice.engine")}
            hideLabel
            value={str(values, "voice.engine", "local")}
            settingKey="voice.engine"
            onChange={(v) => onChange("voice.engine", v)}
            options={[
              {
                value: "local",
                label: t("settings.voice.engine.local"),
                hint: t("settings.voice.engine.localHint"),
              },
              {
                value: "system",
                label: t("settings.voice.engine.system"),
                hint: t("settings.voice.engine.systemHint"),
              },
              {
                value: "cloud",
                label: t("settings.voice.engine.cloud"),
                hint: t("settings.voice.engine.cloudHint"),
              },
            ]}
          />
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export function VoiceSection(props: SystemDictationProps & VoiceChoices = {}): ReactElement {
  const form = useSettingsForm();
  const voices = useGatewayQuery(
    "speech.voices",
    {},
    { enabled: bool(form.values, "voice.conversation.enabled", false) },
  );
  // #481's turn style moves onto §6.4's mode once, the first time this section loads with it.
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current || form.loading) return;
    const writes = migrateVoiceSettings(form.values);
    if (writes.length === 0) return;
    migrated.current = true;
    for (const w of writes) form.onChange(w.key, w.value);
  }, [form.values, form.loading, form.onChange]);
  return (
    <div className="flex flex-col gap-3">
      <VoicePanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        voices={voices.error ? null : (voices.data?.voices ?? [])}
        {...props}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
