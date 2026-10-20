import type { ReactElement } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
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

const KEY_LABEL: Record<string, string> = {
  fn: "fn",
  rightOption: "Right Option",
  rightCommand: "Right Command",
};

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
      ? { tone: "neutral" as const, text: "Helper not running" }
      : status.accessibility === "granted"
        ? { tone: "success" as const, text: "Granted" }
        : status.accessibility === "missing"
          ? { tone: "danger" as const, text: "Needed" }
          : { tone: "neutral" as const, text: "Not checked yet" };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="font-medium">Accessibility</span>
      <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
      <span className="text-xs text-muted-foreground">
        lets the Psyche helper see the key you hold and type into the focused app
      </span>
      {status.helper === "online" && status.accessibility !== "granted" ? (
        <span className="ml-auto flex gap-2">
          {onOpenAccessibility ? (
            <Button type="button" variant="outline" size="xs" onClick={onOpenAccessibility}>
              Open System Settings
            </Button>
          ) : null}
          {onRecheck ? (
            <Button type="button" variant="ghost" size="xs" onClick={onRecheck}>
              Check again
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
      title="Voice & dictation"
      description={
        <>
          Hold <Kbd>{KEY_LABEL[ptt] ?? ptt}</Kbd> to dictate into any message field.
        </>
      }
    >
      <LoadGate
        label="voice settings"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title="Dictation">
          <RadioField
            label="Push-to-talk key"
            inline
            value={ptt}
            settingKey="voice.pushToTalk"
            onChange={(v) => onChange("voice.pushToTalk", v)}
            options={[
              { value: "fn", label: "fn" },
              { value: "rightOption", label: "Right Option" },
              { value: "rightCommand", label: "Right Command" },
            ]}
          />
          <RadioField
            label="Mode"
            inline
            value={str(values, "voice.mode", "hold")}
            settingKey="voice.mode"
            onChange={(v) => onChange("voice.mode", v)}
            options={[
              { value: "hold", label: "Hold to talk" },
              { value: "toggle", label: "Press to start, press to stop" },
            ]}
          />
        </Group>
        {system ? (
          <Group title="In any app">
            <SwitchField
              label="Dictate into any app"
              description={
                <>
                  Hold <Kbd>{KEY_LABEL[ptt] ?? ptt}</Kbd> wherever you are typing. The text goes
                  where your cursor is, never to the agent, and never into password fields.
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
              label="System-wide hotkey"
              description="Press once to start and again to stop, from any app. Backspace turns it off."
              value={str(values, "voice.hotkey", "")}
              onChange={(v) => onChange("voice.hotkey", v)}
              {...(onCheckShortcut ? { onCheck: onCheckShortcut } : {})}
              {...(system.hotkeyTaken ? { takenNow: system.hotkeyTaken } : {})}
            />
          </Group>
        ) : null}
        <Group title="Voice mode">
          <SwitchField
            label="Talk with Psyche"
            description="A Voice button in the composer starts a spoken conversation: Psyche listens, answers out loud and listens again. Approvals still appear as cards on screen; voice never approves anything."
            checked={conversation}
            settingKey="voice.conversation.enabled"
            onChange={(v) => onChange("voice.conversation.enabled", v)}
          />
          {conversation ? (
            <>
              <RadioField
                label="Your turn"
                value={str(values, "voice.conversation.start", "toggle")}
                settingKey="voice.conversation.start"
                onChange={(v) => onChange("voice.conversation.start", v)}
                options={[
                  {
                    value: "toggle",
                    label: "Hands-free",
                    hint: "Psyche answers when you pause.",
                  },
                  {
                    value: "push",
                    label: "Hold a button to talk",
                    hint: "Hold the composer's Hold to talk button while you speak.",
                  },
                ]}
              />
              <RadioField
                label="Psyche's voice"
                value={str(values, "voice.conversation.reply", "gateway")}
                settingKey="voice.conversation.reply"
                onChange={(v) => onChange("voice.conversation.reply", v)}
                options={[
                  {
                    value: "gateway",
                    label: "Persona voice",
                    hint: "The voice set for the persona, or the Mac's system voice.",
                  },
                  {
                    value: "browser",
                    label: "This app's built-in voice",
                    hint: "Starts faster; talking over it works best with headphones.",
                  },
                ]}
              />
              <SwitchField
                label="Interrupt by talking"
                description="Start speaking while Psyche talks and it stops to listen."
                checked={bool(values, "voice.conversation.bargeIn", true)}
                settingKey="voice.conversation.bargeIn"
                onChange={(v) => onChange("voice.conversation.bargeIn", v)}
              />
            </>
          ) : null}
        </Group>
        <Group title="Engine">
          <RadioField
            label="Speech engine"
            hideLabel
            value={str(values, "voice.engine", "local")}
            settingKey="voice.engine"
            onChange={(v) => onChange("voice.engine", v)}
            options={[
              {
                value: "local",
                label: "On this Mac",
                hint: "Whisper runs locally; audio never leaves the Mac.",
              },
              { value: "system", label: "macOS dictation", hint: "Apple's on-device recognizer." },
              {
                value: "cloud",
                label: "Your model provider",
                hint: "Audio goes to the provider you configured.",
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
