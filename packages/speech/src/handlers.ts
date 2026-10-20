import { type MethodParams, type MethodResult, PsycheError } from "@psyche/protocol";
import type { VoiceMemoService } from "./memo.ts";
import type { ReadAloudService } from "./readAloud.ts";
import type { VoiceCallContext, VoiceSessionManager, VoiceStartParams } from "./voice.ts";
import type { VoiceCatalog } from "./voices.ts";

/**
 * `voice.*`, `voice.memo.save`, `speech.readAloud` and `speech.voices` handlers for the Gateway
 * (S01), like `createMemoryHandlers` / `createTaskHandlers`. Params arrive validated against the
 * protocol schemas and the caller already passed the method's scope check; the second argument
 * is the calling device (sessions, read-aloud audio and memo events belong to it). Events are
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
  | "voice.memo.save"
  | "speech.readAloud"
  | "speech.voices";

export const SPEECH_METHODS: readonly SpeechMethod[] = [
  "voice.start",
  "voice.push",
  "voice.stop",
  "voice.cancel",
  "voice.memo.save",
  "speech.readAloud",
  "speech.voices",
];

export type SpeechHandlers = {
  [M in SpeechMethod]: (params: MethodParams<M>, ctx: VoiceCallContext) => Promise<MethodResult<M>>;
};

export interface SpeechHandlerDeps {
  voice: VoiceSessionManager;
  /** Without it `voice.memo.save` answers `unavailable`. */
  memos?: VoiceMemoService;
  /** Without it `speech.readAloud` answers `unavailable`. */
  readAloud?: ReadAloudService;
  /** Without it `speech.voices` answers `unavailable`. */
  catalog?: VoiceCatalog;
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

    async "speech.readAloud"(p, ctx) {
      const readAloud = need(deps.readAloud, "read-aloud");
      const { streamId } = readAloud.start(
        p.messageId,
        ctx.deviceId,
        p.voice === undefined ? {} : { voice: p.voice },
      );
      return { streamId };
    },

    async "speech.voices"(p) {
      const catalog = need(deps.catalog, "the voice catalog");
      const r = await catalog.list(
        p.personaVoice === undefined ? {} : { personaVoice: p.personaVoice },
      );
      return {
        voices: r.voices.map((v) => ({
          ref: v.ref,
          engine: v.engine,
          location: v.location,
          id: v.id,
          name: v.name,
          language: v.language,
          local: v.local,
          default: v.default,
          ...(v.nonCommercial === true ? { nonCommercial: true } : {}),
        })),
        default: r.default,
        unavailable: r.unavailable,
      };
    },
  };
}
