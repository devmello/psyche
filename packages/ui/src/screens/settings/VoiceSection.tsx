import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
import { t } from "../../i18n/core.ts";
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
}: SettingsFormProps & LoadProps & SystemDictationProps): ReactElement {
  const ptt = str(values, "voice.pushToTalk", "fn");
  const systemWide = bool(values, "voice.systemWide", true);
  const conversation = bool(values, "voice.conversation.enabled", false);
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
        <Group title={t("settings.key.voice.conversation.enabled")}>
          <SwitchField
            label={t("settings.voice.talk")}
            description={t("settings.voice.talkHint")}
            checked={conversation}
            settingKey="voice.conversation.enabled"
            onChange={(v) => onChange("voice.conversation.enabled", v)}
          />
          {conversation ? (
            <>
              <RadioField
                label={t("settings.voice.yourTurn")}
                value={str(values, "voice.conversation.start", "toggle")}
                settingKey="voice.conversation.start"
                onChange={(v) => onChange("voice.conversation.start", v)}
                options={[
                  {
                    value: "toggle",
                    label: t("settings.voice.turn.toggle"),
                    hint: t("settings.voice.turn.toggleHint"),
                  },
                  {
                    value: "push",
                    label: t("settings.voice.turn.push"),
                    hint: t("settings.voice.turn.pushHint"),
                  },
                ]}
              />
              <RadioField
                label={t("settings.voice.reply")}
                value={str(values, "voice.conversation.reply", "gateway")}
                settingKey="voice.conversation.reply"
                onChange={(v) => onChange("voice.conversation.reply", v)}
                options={[
                  {
                    value: "gateway",
                    label: t("settings.voice.reply.gateway"),
                    hint: t("settings.voice.reply.gatewayHint"),
                  },
                  {
                    value: "browser",
                    label: t("settings.voice.reply.browser"),
                    hint: t("settings.voice.reply.browserHint"),
                  },
                ]}
              />
              <SwitchField
                label={t("settings.key.voice.conversation.bargeIn")}
                description={t("settings.voice.bargeInHint")}
                checked={bool(values, "voice.conversation.bargeIn", true)}
                settingKey="voice.conversation.bargeIn"
                onChange={(v) => onChange("voice.conversation.bargeIn", v)}
              />
            </>
          ) : null}
        </Group>
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
