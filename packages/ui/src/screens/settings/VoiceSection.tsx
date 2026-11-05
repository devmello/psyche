import type { DictationKey } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
import { t } from "../../i18n/core.ts";
import { isWindows } from "../../lib/platform.ts";
import {
  effectiveHoldKey,
  type HoldKeyRole,
  holdKeyFromCode,
  holdKeyLabel,
  talkKeyChoices,
} from "../../voice/hold-keys.ts";
import { readVoiceSettings } from "../../voice/settings.ts";
import { type ShortcutCheck, ShortcutRecorder, shortcutText } from "./ShortcutRecorder.tsx";
import { SpeechModelGroup } from "./SpeechModel.tsx";
import {
  Advanced,
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
  /** Windows: the keyboard layout in use has AltGr, so Right Alt types characters there. */
  altGrLayout?: boolean;
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
  /** Desktop: the same check for the quick-entry shortcut. */
  onCheckQuickEntryShortcut?: (accelerator: string) => Promise<ShortcutCheck>;
}

/** The desktop's quick-entry (pop-up chat) shortcut; unset means the OS default. */
export const QUICK_ENTRY_SHORTCUT_KEY = "quickEntry.shortcut";

/**
 * What the desktop registers while `quickEntry.shortcut` is unset: the first of these that no
 * other app holds (apps/desktop/src/main/shortcuts.ts `quickEntryShortcuts`). Windows' Alt+Space
 * is every window's system menu, so it starts at Ctrl+Alt+Space there.
 */
export function quickEntryDefaults(): readonly [string, string] {
  return isWindows()
    ? ["Control+Alt+Space", "Alt+Shift+Space"]
    : ["Alt+Space", "Control+Alt+Space"];
}

/** Ask about screen's default (apps/desktop/src/main/shortcuts.ts `screenAskShortcuts`). */
export function screenAskDefault(): string {
  return isWindows() ? "Control+Alt+Shift+Space" : "Alt+Shift+Space";
}

/** Quick entry, the pop-up chat (docs/06 §3.21): desktop only. */
export function QuickEntryGroup({
  values,
  onChange,
  onCheck,
}: Pick<SettingsFormProps, "values" | "onChange"> & {
  onCheck?: (accelerator: string) => Promise<ShortcutCheck>;
}): ReactElement {
  const [primary, fallback] = quickEntryDefaults();
  return (
    <Group title={t("settings.quickEntry.title")}>
      <ShortcutRecorder
        label={t("settings.key.quickEntry.shortcut")}
        description={t("settings.quickEntry.shortcutHint", {
          keys: shortcutText(primary),
          fallback: shortcutText(fallback),
        })}
        value={str(values, QUICK_ENTRY_SHORTCUT_KEY, "")}
        defaultValue={primary}
        own="quickEntry"
        onChange={(v) => onChange(QUICK_ENTRY_SHORTCUT_KEY, v)}
        {...(onCheck ? { onCheck } : {})}
      />
    </Group>
  );
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
            value={str(values, "screenAsk.shortcut", screenAskDefault())}
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

/**
 * The key a stored hold-to-talk value means here (`voice/hold-keys.ts`): on Windows a Mac name
 * an older Settings stored is the key the helper holds for it (fn → Right Alt), and an unset key
 * is Right Ctrl. The desktop's Windows key hook reads the setting the same way.
 */
export function effectiveTalkKey(key: unknown, role: HoldKeyRole = "dictation"): DictationKey {
  return effectiveHoldKey(key, role);
}

/**
 * A hold-to-talk key: the keys this keyboard has as choices, and on Windows any other key that
 * can be held (F13–F24, Right Shift, Insert…) by pressing it. Right Alt warns on an AltGr layout;
 * Caps Lock says it keeps its state.
 */
function HoldKeyField({
  label,
  description,
  value,
  settingKey,
  onChange,
  taken,
  altGrLayout,
  labelOf = holdKeyLabel,
}: {
  label: string;
  description?: string;
  value: DictationKey;
  settingKey: string;
  onChange: (key: DictationKey) => void;
  /** The other role's key: shown, not choosable. */
  taken?: DictationKey;
  altGrLayout?: boolean;
  /** How an option reads (default: the key's name on this keyboard). */
  labelOf?: (key: DictationKey) => string;
}): ReactElement {
  const [capturing, setCapturing] = useState(false);
  const [refused, setRefused] = useState(false);
  const choices = talkKeyChoices();
  const keys = choices.includes(value) ? choices : [...choices, value];
  const note =
    value === "rightAlt" && altGrLayout === true
      ? t("settings.voice.key.altGrWarning")
      : value === "capsLock"
        ? t("settings.voice.key.capsLockHint")
        : null;
  return (
    <div className="flex flex-col gap-2">
      <RadioField
        label={label}
        {...(description === undefined ? {} : { description })}
        inline
        value={value}
        settingKey={settingKey}
        onChange={onChange}
        options={keys.map((k) => ({ value: k, label: labelOf(k), disabled: k === taken }))}
      />
      {isWindows() ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-callout text-muted-foreground">
            {t("settings.voice.key.other")}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={capturing}
            onClick={() => {
              setRefused(false);
              setCapturing(!capturing);
            }}
            onBlur={() => setCapturing(false)}
            onKeyDown={(e) => {
              if (!capturing) return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Escape") {
                setCapturing(false);
                return;
              }
              const key = holdKeyFromCode(e.code);
              if (key === undefined || key === taken) {
                setRefused(true);
                return;
              }
              setRefused(false);
              setCapturing(false);
              onChange(key);
            }}
          >
            {capturing ? t("settings.voice.key.pressNow") : t("settings.voice.key.press")}
          </Button>
          {refused ? (
            <span role="alert" className="text-callout text-danger-text">
              {t("settings.voice.key.cantUse")}
            </span>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <p className="text-callout text-muted-foreground" data-testid="hold-key-note">
          {note}
        </p>
      ) : null}
    </div>
  );
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
  // Windows has no Accessibility grant: the helper's key hook needs no permission, so the row
  // says what the helper is doing and where Windows draws the line (elevated apps).
  if (isWindows()) {
    const off = status.helper === "offline";
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("platform.term.helper")}</span>
        <StatusChip tone={off ? "neutral" : "success"}>
          {off ? t("settings.voice.access.helperOff") : t("platform.windows.access.noPermission")}
        </StatusChip>
        <span className="text-callout text-muted-foreground">
          {t("settings.voice.access.windowsWhy")}
        </span>
      </div>
    );
  }
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
      <span className="text-callout text-muted-foreground">{t("settings.voice.access.why")}</span>
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
  altGrLayout,
}: Pick<SettingsFormProps, "values" | "onChange"> & { altGrLayout?: boolean }): ReactElement {
  const v = readVoiceSettings(values);
  const dictationKey = effectiveTalkKey(values["voice.pushToTalk"]);
  const voiceKey = effectiveTalkKey(v.key, "voice");
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
          <HoldKeyField
            label={t("voice.settings.key")}
            description={
              voiceKey === dictationKey ? t("voice.settings.keyClash") : t("voice.settings.keyHint")
            }
            value={voiceKey}
            settingKey="voice.conversation.key"
            onChange={(k) => onChange("voice.conversation.key", k)}
            taken={dictationKey}
            // A Mac names the voice keys by their glyphs (Right ⌘), as the pop-up does.
            labelOf={(k) =>
              !isWindows() && (k === "fn" || k === "rightOption" || k === "rightCommand")
                ? t(`voice.key.${k}`)
                : holdKeyLabel(k)
            }
            {...(altGrLayout === undefined ? {} : { altGrLayout })}
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
  onCheckQuickEntryShortcut,
}: SettingsFormProps & LoadProps & SystemDictationProps): ReactElement {
  const ptt = effectiveTalkKey(values["voice.pushToTalk"]);
  const systemWide = bool(values, "voice.systemWide", true);
  const altGrLayout = system?.altGrLayout;
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title={t("settings.nav.voice")}
      description={
        <>
          {t("settings.voice.hold")} <Kbd>{holdKeyLabel(ptt)}</Kbd> {t("settings.voice.toDictate")}
        </>
      }
    >
      <LoadGate
        label={t("settings.voice.loadLabel")}
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group
          title={t("settings.voice.dictation")}
          description={t("settings.voice.dictationHint")}
        >
          <HoldKeyField
            label={t("settings.key.voice.pushToTalk")}
            value={ptt}
            settingKey="voice.pushToTalk"
            onChange={(v) => onChange("voice.pushToTalk", v)}
            {...(altGrLayout === undefined ? {} : { altGrLayout })}
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
        <SpeechModelGroup />
        {system ? (
          <Group title={t("settings.voice.anyApp")}>
            <SwitchField
              label={t("settings.key.voice.systemWide")}
              description={
                <>
                  {t("settings.voice.hold")} <Kbd>{holdKeyLabel(ptt)}</Kbd>{" "}
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
          <QuickEntryGroup
            values={values}
            onChange={onChange}
            {...(onCheckQuickEntryShortcut ? { onCheck: onCheckQuickEntryShortcut } : {})}
          />
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
          {...(altGrLayout === undefined ? {} : { altGrLayout })}
        />
        <Advanced description={t("settings.voice.advancedHint")}>
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
        </Advanced>
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
