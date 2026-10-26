import {
  GatewayProvider,
  readVoiceSettings,
  UiSlotsProvider,
  useSettings,
  useVoiceConversation,
  VoiceHudView,
  type VoiceTerminal,
} from "@psyche/ui";
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import type { ShellPlatform } from "../shell/platform.ts";
import { duckForScreenReader } from "../shell/screen-reader.ts";
import { microphoneSource } from "../shell/voice.ts";
import { VoiceConversationTerminal, webConversationPlayer } from "../shell/voice-conversation.ts";
import { kitClient } from "./kit-client.ts";

/**
 * The voice HUD's renderer (docs/voice/voice-mode-2026.md §6.2): the desktop opens it in a
 * floating, non-activating panel while the voice key is held in another app. Like the in-app
 * capsule, this renderer is the audio terminal (capture and playback stay in the renderer, §3
 * decision 6). The voice key arrives as the Gateway's `dictation.key` event with `role: "voice"`.
 * It closes 4 s after the last reply, and clicking it opens the conversation in Psyche.
 */

/** What the desktop's HUD window offers its renderer (preload `voiceHud`). */
export interface VoiceHudBridge {
  /** The conversation is over or idle: hide the panel. */
  done(): void;
  /** Open the conversation's thread in Psyche (null: the main chat). */
  openThread(threadId: string | null): void;
}

export const VOICE_HUD_ROUTE = "/voice-hud";
/** The HUD closes this long after the last reply (§6.2). */
export const HUD_IDLE_MS = 4000;

export interface VoiceHudProps {
  platform: ShellPlatform;
  bridge?: VoiceHudBridge;
  /** Tests inject a terminal; the HUD builds the renderer's otherwise. */
  terminal?: VoiceTerminal;
  /** How long after the last reply the HUD closes (tests shorten it). */
  idleMs?: number;
}

export function VoiceHud({
  platform,
  bridge,
  terminal,
  idleMs = HUD_IDLE_MS,
}: VoiceHudProps): ReactElement {
  const client = useMemo(() => kitClient(platform.gateway), [platform]);
  return (
    <GatewayProvider client={client}>
      <HudTerminal platform={platform} {...(terminal ? { terminal } : {})}>
        <HudBody platform={platform} idleMs={idleMs} {...(bridge ? { bridge } : {})} />
      </HudTerminal>
    </GatewayProvider>
  );
}

function HudTerminal({
  platform,
  terminal,
  children,
}: {
  platform: ShellPlatform;
  terminal?: VoiceTerminal;
  children: ReactElement;
}): ReactElement {
  const { settings } = useSettings();
  const bargeIn = useRef(true);
  bargeIn.current = readVoiceSettings(settings).bargeIn;
  const built = useMemo(
    () =>
      terminal ??
      new VoiceConversationTerminal({
        call: (m, p) => platform.gateway.call(m, p),
        tap: (listener) => platform.gateway.onEvent((e) => listener(e.event, e.payload)),
        source: microphoneSource(),
        player: webConversationPlayer,
        bargeIn: () => bargeIn.current,
      }),
    [platform, terminal],
  );
  useEffect(() => () => built.end(), [built]);
  useEffect(
    () => (built instanceof VoiceConversationTerminal ? duckForScreenReader(built) : undefined),
    [built],
  );
  const slots = useMemo(() => ({ voiceTerminal: built }), [built]);
  return <UiSlotsProvider value={slots}>{children}</UiSlotsProvider>;
}

function HudBody({
  platform,
  bridge,
  idleMs,
}: {
  platform: ShellPlatform;
  bridge?: VoiceHudBridge;
  idleMs: number;
}): ReactElement | null {
  // The HUD talks on the main thread (§4.1); the desktop passes a side chat in the route if one
  // was frontmost when the key went down.
  const threadId = new URLSearchParams(globalThis.location?.search ?? "").get("thread");
  const conversation = useVoiceConversation(threadId);
  const c = useRef(conversation);
  c.current = conversation;
  // A key press before the conversation exists: begin the turn once it does (push-to-talk).
  const pending = useRef<"begin" | null>(null);

  useEffect(
    () =>
      platform.gateway.onEvent((e) => {
        if (e.event !== "dictation.key") return;
        const p = e.payload as { role?: string; down?: boolean };
        if (p.role !== "voice") return;
        const conv = c.current;
        if (!conv) return;
        const push = conv.settings.mode === "push";
        if (p.down) {
          if (!conv.active) {
            conv.start();
            if (push) pending.current = "begin";
          } else if (push) conv.talk("begin");
          else conv.talk(conv.session.listening ? "end" : "begin");
        } else if (push) {
          if (pending.current) pending.current = null;
          else conv.talk("end");
        }
      }),
    [platform],
  );

  // Once the conversation exists, begin the turn the key asked for.
  const started = conversation?.session.conversationId ?? null;
  useEffect(() => {
    if (started && pending.current === "begin") {
      pending.current = null;
      c.current?.talk("begin");
    }
  }, [started]);

  // Close 4 s after the last reply: listening again with the mic closed between turns, or ended.
  // Only once a conversation has run here, so a slow first key event can't hide the panel.
  const [ran, setRan] = useState(false);
  if (started && !ran) setRan(true);
  const phase = conversation?.session.phase ?? "idle";
  const idle =
    ran && (!conversation?.active || (phase === "listening" && !conversation.session.listening));
  useEffect(() => {
    if (!idle) return;
    const id = setTimeout(() => {
      if (c.current?.active) c.current.end();
      setRan(false);
      bridge?.done();
    }, idleMs);
    return () => clearTimeout(id);
  }, [idle, bridge, idleMs]);

  if (!conversation) return null;
  return (
    <VoiceHudView
      session={conversation.session}
      settings={conversation.settings}
      onTalk={conversation.talk}
      onToggleMute={conversation.toggleMute}
      onStopSpeaking={conversation.stopSpeaking}
      onEnd={() => {
        conversation.end();
        bridge?.done();
      }}
      onOpen={() => bridge?.openThread(threadId)}
      levels={() => conversation.terminal.levels()}
    />
  );
}
