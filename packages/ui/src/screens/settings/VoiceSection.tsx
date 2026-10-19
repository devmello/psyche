import type { ReactElement } from "react";
import { Kbd } from "../../components/ui/kbd.tsx";
import {
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  RadioField,
  SectionFrame,
  type SettingsFormProps,
  str,
  TextSetting,
  useSettingsForm,
} from "./shared.tsx";

/** Voice & dictation (UI design §3.18): push-to-talk key, toggle mode, global hotkey, engine. */

export function VoicePanel({
  values,
  onChange,
  needsApproval,
  loading,
  error,
  onRetry,
}: SettingsFormProps & LoadProps): ReactElement {
  const ptt = str(values, "voice.pushToTalk", "fn");
  return (
    <SectionFrame
      needsApproval={needsApproval}
      title="Voice & dictation"
      description={
        <>
          Hold <Kbd>{ptt === "fn" ? "fn" : ptt === "rightOption" ? "Right ⌥" : "Right ⌘"}</Kbd> to
          dictate into any message field.
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
          <TextSetting
            label="System-wide hotkey"
            description="Starts dictation from any app. Leave empty to turn it off."
            value={str(values, "voice.hotkey", "")}
            placeholder="Control+Option+D"
            settingKey="voice.hotkey"
            onCommit={(v) => onChange("voice.hotkey", v)}
          />
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

export function VoiceSection(): ReactElement {
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
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
