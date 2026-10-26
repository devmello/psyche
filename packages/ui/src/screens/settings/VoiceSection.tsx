import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
import { t } from "../../i18n/core.ts";
import { readVoiceSettings, VOICE_KEYS } from "../../voice/settings.ts";
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

/**
 * Settings → Voice & dictation → Talk with Psyche: the voice key (never the dictation key) that
 * opens the pop-up from any app, and review before sending. Psyche answers in text, so there is
 * nothing to choose about a voice.
 */
export function VoiceConversationGroup({
  values,
  onChange,
}: Pick<SettingsFormProps, "values" | "onChange">): ReactElement {
  const v = readVoiceSettings(values);
  const dictationKey = str(values, "voice.pushToTalk", "fn");
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
            options={VOICE_KEYS.map((k) => ({
              value: k,
              label: t(`voice.key.${k}`),
              disabled: k === dictationKey,
            }))}
          />
          <SwitchField
            label={t("voice.settings.review")}
            description={t("voice.settings.reviewHint")}
            checked={v.reviewBeforeSend}
            settingKey="voice.conversation.reviewBeforeSend"
            onChange={(on) => onChange("voice.conversation.reviewBeforeSend", on)}
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
}: SettingsFormProps & LoadProps & SystemDictationProps): ReactElement {
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
        <VoiceConversationGroup values={values} onChange={onChange} />
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

export function VoiceSection(props: SystemDictationProps = {}): ReactElement {
  const form = useSettingsForm();
  return (
    <div className="flex flex-col gap-3">
      <VoicePanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        {...props}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
