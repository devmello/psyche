import type {
  EventPayload,
  VoiceConversationEndReason,
  VoiceConversationMode,
  VoiceConversationPhase,
  VoiceConversationReason,
} from "@psyche/protocol";
import { useEffect, useReducer } from "react";
import { useStore } from "../data/provider.tsx";

/**
 * A voice conversation as the capsule and the HUD draw it (docs/voice/voice-mode-2026.md §6),
 * folded from V-G's `voice.conversation.*` events. Pure: the kit's hook, the HUD and the tests
 * feed the same reducer.
 */

export type VoicePhase = "idle" | "starting" | VoiceConversationPhase;

export interface VoiceSession {
  conversationId: string | null;
  mode: VoiceConversationMode;
  phase: VoicePhase;
  reason: VoiceConversationReason | null;
  /** The microphone audio is being transcribed (the Gateway's word): the "Mic on" chip. */
  listening: boolean;
  /** Hands-free: the owner closed the mic; the conversation stays. */
  muted: boolean;
  /** While waiting for a spoken answer to an approval or question. */
  approvalId: string | null;
  prompt: string | null;
  windowMs: number | null;
  /** When the listening window opened (epoch ms), for the draining ring. */
  windowAt: number | null;
  /** The one caption line: the owner's words while listening, Psyche's sentence while speaking. */
  caption: { role: "owner" | "agent"; text: string; final: boolean } | null;
  /** The step line while it works ("Checking your calendar"). */
  step: { label: string; status: string } | null;
  ended: { reason: VoiceConversationEndReason; message?: string } | null;
  /** Why it couldn't start (no microphone, no speech engine). */
  error: string | null;
}

export const IDLE_SESSION: VoiceSession = {
  conversationId: null,
  mode: "push",
  phase: "idle",
  reason: null,
  listening: false,
  muted: false,
  approvalId: null,
  prompt: null,
  windowMs: null,
  windowAt: null,
  caption: null,
  step: null,
  ended: null,
  error: null,
};

export type VoiceAction =
  | { type: "starting"; mode: VoiceConversationMode }
  | { type: "started"; conversationId: string }
  | { type: "failed"; error: string }
  | { type: "muted"; muted: boolean }
  | { type: "reset" }
  | { type: "state"; payload: EventPayload<"voice.conversation.state">; at: number }
  | { type: "caption"; payload: EventPayload<"voice.conversation.caption"> }
  | { type: "step"; payload: EventPayload<"voice.conversation.step"> }
  | { type: "ended"; payload: EventPayload<"voice.conversation.ended"> };

/** Whether an event belongs to this session (the first state event adopts a starting session). */
function mine(s: VoiceSession, conversationId: string): boolean {
  return (
    s.conversationId === conversationId || (s.conversationId === null && s.phase === "starting")
  );
}

export function voiceReducer(s: VoiceSession, a: VoiceAction): VoiceSession {
  switch (a.type) {
    case "starting":
      return { ...IDLE_SESSION, mode: a.mode, phase: "starting" };
    case "started":
      return s.phase === "idle" ? s : { ...s, conversationId: a.conversationId };
    case "failed":
      return { ...IDLE_SESSION, mode: s.mode, error: a.error };
    case "muted":
      return { ...s, muted: a.muted, listening: a.muted ? false : s.listening };
    case "reset":
      return { ...IDLE_SESSION, mode: s.mode };
    case "state": {
      const p = a.payload;
      if (!mine(s, p.conversationId)) return s;
      if (p.phase === "ended") return { ...IDLE_SESSION, mode: s.mode };
      const waiting = p.phase === "waiting";
      return {
        ...s,
        conversationId: p.conversationId,
        phase: p.phase,
        reason: p.reason ?? null,
        listening: s.muted ? false : p.listening,
        approvalId: waiting ? (p.approvalId ?? null) : null,
        prompt: waiting ? (p.prompt ?? null) : null,
        windowMs: waiting ? (p.windowMs ?? null) : null,
        windowAt: waiting && p.windowMs !== undefined ? a.at : null,
        // A new turn of the owner's starts with an empty caption; the step line clears when
        // Psyche starts speaking or listens again.
        caption: p.phase === "listening" && s.phase !== "listening" ? null : s.caption,
        step: p.phase === "thinking" || p.phase === "waiting" ? s.step : null,
      };
    }
    case "caption": {
      const p = a.payload;
      if (!mine(s, p.conversationId)) return s;
      return { ...s, caption: { role: p.role, text: p.text, final: p.final } };
    }
    case "step": {
      const p = a.payload;
      if (!mine(s, p.conversationId)) return s;
      return { ...s, step: { label: p.label, status: p.status } };
    }
    case "ended": {
      const p = a.payload;
      if (!mine(s, p.conversationId)) return s;
      return {
        ...IDLE_SESSION,
        mode: s.mode,
        ended: { reason: p.reason, ...(p.error ? { message: p.error.message } : {}) },
      };
    }
  }
}

export function sessionActive(s: VoiceSession): boolean {
  return s.phase !== "idle";
}

/** The Mic on chip: true only while the Gateway transcribes and the owner hasn't muted. */
export function micOn(s: VoiceSession): boolean {
  return sessionActive(s) && s.listening && !s.muted;
}

/**
 * The session for this device, from the Gateway's events. `dispatch` lets the caller record its
 * own actions (starting, started, muted).
 */
export function useVoiceSession(): [VoiceSession, (a: VoiceAction) => void] {
  const store = useStore();
  const [session, dispatch] = useReducer(voiceReducer, IDLE_SESSION);
  useEffect(
    () =>
      store.client.subscribe((e) => {
        switch (e.event) {
          case "voice.conversation.state":
            dispatch({
              type: "state",
              payload: e.payload as EventPayload<"voice.conversation.state">,
              at: Date.now(),
            });
            break;
          case "voice.conversation.caption":
            dispatch({
              type: "caption",
              payload: e.payload as EventPayload<"voice.conversation.caption">,
            });
            break;
          case "voice.conversation.step":
            dispatch({
              type: "step",
              payload: e.payload as EventPayload<"voice.conversation.step">,
            });
            break;
          case "voice.conversation.ended":
            dispatch({
              type: "ended",
              payload: e.payload as EventPayload<"voice.conversation.ended">,
            });
            break;
        }
      }),
    [store],
  );
  return [session, dispatch];
}
