import { t } from "@psyche/ui";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import type { ShellStore } from "../store.ts";
import { microphoneSource, webSpeechDictation } from "../voice.ts";
import {
  browserSpeaker,
  GatewaySpeaker,
  VOICE_MODE_KEYS,
  VoiceMode,
  type VoiceModePhase,
  type VoiceModeSettings,
  voiceModeLabel,
  voiceModeSettings,
  webAudioPlayer,
} from "../voice-mode.ts";

/**
 * Voice mode in the composer (feature Q5). Hidden unless Settings → Voice & dictation → Voice mode
 * is on. A "Voice" pill starts and ends the conversation; while it runs, a bar above the composer
 * shows the state (listening / thinking / speaking / needs you), what was heard, a hold-to-talk
 * button in push-to-talk mode and End. Approvals still arrive as cards; this bar has no way to
 * answer them.
 */

const KEYS = Object.values(VOICE_MODE_KEYS);

export function useVoiceMode(store: ShellStore, threadId: string | null) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [state, setState] = useState<VoiceModePhase>({ phase: "off" });
  const settings = voiceModeSettings(values);

  useEffect(() => {
    void store
      .call<{ settings: Record<string, unknown> }>("settings.get", { keys: KEYS })
      .then((r) => r?.settings && setValues(r.settings))
      .catch(() => undefined);
    return store.tap((e) => {
      if (e.event !== "settings.changed") return;
      const entries = (e.payload as { entries?: { key: string; value: unknown }[] }).entries ?? [];
      const mine = entries.filter((x) => (KEYS as string[]).includes(x.key));
      if (mine.length > 0)
        setValues((v) => ({ ...v, ...Object.fromEntries(mine.map((x) => [x.key, x.value])) }));
    });
  }, [store]);

  // One controller per settings combination; a change ends the running conversation.
  const { enabled, start, reply, bargeIn } = settings;
  const vm = useMemo(() => {
    if (!enabled) return undefined;
    const call = (m: string, p: unknown) => store.call(m, p);
    const speaker =
      (reply === "browser" ? browserSpeaker() : undefined) ??
      new GatewaySpeaker(call, webAudioPlayer);
    const local = webSpeechDictation();
    return new VoiceMode({
      call,
      source: microphoneSource(),
      speaker,
      settings: { enabled, start, reply, bargeIn },
      onState: setState,
      ...(local ? { local } : {}),
    });
  }, [store, enabled, start, reply, bargeIn]);

  useEffect(() => {
    if (!vm) return;
    const off = store.tap((e) => vm.onEvent(e.event, e.payload));
    return () => {
      off();
      vm.stop();
    };
  }, [store, vm]);

  // Switching threads ends the conversation: it belongs to the thread it started in.
  useEffect(() => {
    if (vm?.thread != null && vm.thread !== threadId) vm.stop();
  }, [vm, threadId]);

  return {
    settings,
    state,
    available: vm !== undefined,
    toggle: () => {
      if (!vm) return;
      if (vm.active) vm.stop();
      else if (threadId) void vm.start(threadId);
    },
    pushStart: () => vm?.pushStart(),
    pushEnd: () => vm?.pushEnd(),
  };
}

export function VoiceModeBar(props: {
  state: VoiceModePhase;
  settings: VoiceModeSettings;
  onEnd: () => void;
  onPushStart: () => void;
  onPushEnd: () => void;
}): ReactElement | null {
  const { state, settings } = props;
  if (state.phase === "off") return null;
  const heard =
    state.phase === "listening" ? state.partial : state.phase === "thinking" ? state.said : "";
  const push = settings.start === "push";
  return (
    <div className="voice-mode" data-testid="voice-mode" data-phase={state.phase}>
      <span className="pill voice-mode-state" role="status" aria-live="polite">
        {voiceModeLabel(state)}
        {state.phase === "speaking" && settings.bargeIn ? t("web.voiceMode.talkToInterrupt") : ""}
      </span>
      <span className="grow voice-mode-heard" title={t("web.voiceMode.heard")}>
        {heard}
      </span>
      {push ? (
        <button
          type="button"
          className="pill"
          aria-pressed={state.phase === "listening"}
          disabled={state.phase === "waiting" || state.phase === "thinking"}
          onPointerDown={props.onPushStart}
          onPointerUp={props.onPushEnd}
          onPointerLeave={props.onPushEnd}
          data-testid="voice-mode-talk"
        >
          {t("web.voiceMode.holdToTalk")}
        </button>
      ) : null}
      <button type="button" className="pill" onClick={props.onEnd} data-testid="voice-mode-end">
        {t("web.voiceMode.end")}
      </button>
    </div>
  );
}
