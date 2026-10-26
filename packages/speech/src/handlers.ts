import { type MethodParams, type MethodResult, PsycheError } from "@psyche/protocol";
import type { VoiceMemoService } from "./memo.ts";
import type { VoiceCallContext, VoiceSessionManager, VoiceStartParams } from "./voice.ts";

/**
 * `voice.*` dictation and `voice.memo.save` handlers for the Gateway
 * (S01), like `createMemoryHandlers` / `createTaskHandlers`. Params arrive validated against the
 * protocol schemas and the caller already passed the method's scope check; the second argument
 * is the calling device (sessions and memo events belong to it). Events are
 * delivered by the `emit` callbacks the services were built with.
 *
 * Mount with a small adapter that passes `{deviceId: call.identity.deviceId, caller}` where
 * `caller` is `"web"` for the browser client and `"desktop"` otherwise (Web Speech is only
 * offered to `web`).
 */

export type SpeechMethod =
  | "voice.start"
  | "voice.push"
  | "voice.stop"
  | "voice.cancel"
  | "voice.memo.save";

export const SPEECH_METHODS: readonly SpeechMethod[] = [
  "voice.start",
  "voice.push",
  "voice.stop",
  "voice.cancel",
  "voice.memo.save",
];

export type SpeechHandlers = {
  [M in SpeechMethod]: (params: MethodParams<M>, ctx: VoiceCallContext) => Promise<MethodResult<M>>;
};

export interface SpeechHandlerDeps {
  voice: VoiceSessionManager;
  /** Without it `voice.memo.save` answers `unavailable`. */
  memos?: VoiceMemoService;
}

function need<T>(dep: T | undefined, what: string): T {
  if (dep === undefined) throw new PsycheError("unavailable", `${what} is not configured`);
  return dep;
}

export function createSpeechHandlers(deps: SpeechHandlerDeps): SpeechHandlers {
  return {
    async "voice.start"(p, ctx) {
      const params: VoiceStartParams = { format: p.format };
      if (p.language !== undefined) params.language = p.language;
      if (p.vocabulary !== undefined) params.vocabulary = p.vocabulary;
      if (p.threadId !== undefined) params.threadId = p.threadId;
      if (p.memo !== undefined) params.memo = p.memo;
      return deps.voice.start(params, ctx);
    },

    async "voice.push"(p, ctx) {
      deps.voice.push(p, ctx);
      return {};
    },

    async "voice.stop"(p, ctx) {
      return { transcript: await deps.voice.stop(p.sessionId, ctx) };
    },

    async "voice.cancel"(p, ctx) {
      deps.voice.cancel(p.sessionId, ctx);
      return { ok: true };
    },

    async "voice.memo.save"(p, ctx) {
      const memos = need(deps.memos, "voice memos");
      const r = await memos.fromDictation(deps.voice, p.sessionId, ctx, {
        threadId: p.threadId ?? null,
        ...(p.task === undefined ? {} : { task: p.task }),
      });
      return {
        transcript: r.transcript,
        item: r.item,
        task: r.task,
        provenance: r.provenance,
        content: {
          urls: r.content.urls,
          instructionLike: r.content.instructionLike,
          flags: r.content.flags,
        },
        blocks: r.blocks,
        durationMs: Math.round(r.durationMs),
      };
    },
  };
}
