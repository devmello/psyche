import { join } from "node:path";
import type { NodeClient, ResolvedSecret, SpeechEngine } from "@psyche/protocol";
import { DecodingSpeechEngine } from "./adapters.ts";
import { DEFAULT_KOKORO_MODEL, DEFAULT_WHISPER_MODEL, MODEL_CATALOG } from "./catalog.ts";
import { CloudTtsEngine } from "./engines/cloud.ts";
import {
  KokoroEngine,
  KokoroOnnxRuntime,
  type OrtModuleLike,
  type Phonemizer,
} from "./engines/kokoro.ts";
import { NODE_SPEECH_CAPABILITIES, NodeSpeechEngine } from "./engines/node.ts";
import { PhonemizePhonemizer } from "./engines/phonemize.ts";
import { WEB_SPEECH_ENTRY } from "./engines/web.ts";
import { isEnglishOnlyModel, WhisperCliBackend, WhisperEngine } from "./engines/whisper.ts";
import { ModelManager } from "./models.ts";
import {
  DEFAULT_SPEECH_SETTINGS,
  RoutedSpeechEngine,
  SpeechEngineSelector,
  type SpeechSettings,
} from "./policy.ts";
import type { ProcessRunner } from "./process.ts";
import { VoiceNoteTranscoder } from "./transcode/ffmpeg.ts";

export * from "./adapters.ts";
export * from "./audio.ts";
export * from "./catalog.ts";
export * from "./conversation/index.ts";
export * from "./engines/cloud.ts";
export * from "./engines/kokoro.ts";
export * from "./engines/node.ts";
export * from "./engines/phonemize.ts";
export * from "./engines/web.ts";
export * from "./engines/whisper.ts";
export * from "./handlers.ts";
export * from "./memo.ts";
export * from "./models.ts";
export * from "./policy.ts";
export * from "./process.ts";
export * from "./queue.ts";
export * from "./readAloud.ts";
export * from "./ssml.ts";
export * from "./stream.ts";
export * from "./transcode/caf.ts";
export * from "./transcode/ffmpeg.ts";
export * from "./transcode/formats.ts";
export * from "./vocabulary.ts";
export * from "./voice.ts";
export * from "./voices.ts";

export interface SpeechStackOptions {
  /** `$PSYCHE_HOME`; models live under `models/`. */
  home?: string;
  settings?: SpeechSettings;
  /** The Mac node to use now (paired and online), if any. */
  macNode?: () => NodeClient | undefined | Promise<NodeClient | undefined>;
  /** Owner opt-in for Apple Personal Voice on the Mac node (`speech.tts.personalVoice`, Q3). */
  personalVoice?: () => boolean | Promise<boolean>;
  /** Runner for ffmpeg and whisper-cli (wrap with `srt` / the sandbox in the Gateway). */
  runner?: ProcessRunner;
  whisper?: { binary?: string; model?: string; threads?: number };
  ffmpeg?: { ffmpeg?: string; ffprobe?: string };
  /** `onnxruntime-node`, loaded by the Gateway; Kokoro is unavailable without it. */
  ort?: OrtModuleLike | (() => Promise<OrtModuleLike>);
  kokoro?: { model?: string; phonemizer?: Phonemizer; defaultVoice?: string };
  /** Registered only when present; add `openai` / `elevenlabs` to `tts.order` to use them. */
  cloud?: {
    openai?: () => Promise<ResolvedSecret>;
    elevenlabs?: () => Promise<ResolvedSecret>;
  };
}

export interface SpeechStack {
  selector: SpeechEngineSelector;
  /** Per-call routed engine for the Gateway's own use (channels, read-aloud); decodes compressed input. */
  engine: SpeechEngine;
  transcoder: VoiceNoteTranscoder;
  models: ModelManager;
}

/**
 * Wires the default engines (feature Q1/Q3, ADR-014): Mac node → whisper.cpp → Web Speech for
 * transcription; Kokoro → Mac node for synthesis; cloud voices only when configured. Nothing is
 * downloaded here; engines whose model is missing report unavailable.
 */
export function createSpeechStack(options: SpeechStackOptions = {}): SpeechStack {
  const models = new ModelManager(
    options.home === undefined
      ? { catalog: MODEL_CATALOG }
      : { home: options.home, catalog: MODEL_CATALOG },
  );
  const runnerOpt = options.runner === undefined ? {} : { runner: options.runner };
  const transcoder = new VoiceNoteTranscoder({ ...options.ffmpeg, ...runnerOpt });
  const selector = new SpeechEngineSelector(options.settings ?? DEFAULT_SPEECH_SETTINGS);

  const macNode = options.macNode;
  if (macNode !== undefined) {
    const node = new NodeSpeechEngine({
      node: macNode,
      ...(options.personalVoice === undefined ? {} : { personalVoice: options.personalVoice }),
    });
    selector.register({
      id: "mac-node",
      location: "node",
      supports: { transcribe: true, stream: true, synthesize: true },
      engine: node,
      available: () => node.available(NODE_SPEECH_CAPABILITIES.transcribeStream),
    });
  }

  const whisperModel = models.path(options.whisper?.model ?? DEFAULT_WHISPER_MODEL);
  const whisper = new WhisperEngine({
    backend: new WhisperCliBackend({
      modelPath: whisperModel,
      ...(options.whisper?.binary === undefined ? {} : { binary: options.whisper.binary }),
      ...(options.whisper?.threads === undefined ? {} : { threads: options.whisper.threads }),
      ...runnerOpt,
    }),
    englishOnly: isEnglishOnlyModel(whisperModel),
    decode: (data, _format, signal) =>
      transcoder.decode(data, signal === undefined ? {} : { signal }),
  });
  selector.register({
    id: "whisper",
    location: "gateway",
    supports: { transcribe: true, stream: true, synthesize: false },
    engine: whisper,
    available: () => whisper.available(),
  });
  selector.register(WEB_SPEECH_ENTRY);

  if (options.ort !== undefined) {
    const modelPath = models.path(options.kokoro?.model ?? DEFAULT_KOKORO_MODEL);
    const kokoro = new KokoroEngine({
      runtime: new KokoroOnnxRuntime({
        ort: options.ort,
        modelPath,
        tokenizerPath: models.path("kokoro-tokenizer"),
        voicesDir: join(models.dir, "kokoro", "voices"),
      }),
      phonemizer: options.kokoro?.phonemizer ?? new PhonemizePhonemizer(),
      ...(options.kokoro?.defaultVoice === undefined
        ? {}
        : { defaultVoice: options.kokoro.defaultVoice }),
    });
    selector.register({
      id: "kokoro",
      location: "gateway",
      supports: { transcribe: false, stream: false, synthesize: true },
      engine: kokoro,
      available: () => kokoro.available(),
    });
  }

  for (const provider of ["openai", "elevenlabs"] as const) {
    const apiKey = options.cloud?.[provider];
    if (apiKey === undefined) continue;
    const engine = new CloudTtsEngine({ provider, apiKey });
    selector.register({
      id: provider,
      location: "cloud",
      supports: { transcribe: false, stream: false, synthesize: true },
      engine,
      available: async () => true,
    });
  }

  return {
    selector,
    engine: new DecodingSpeechEngine(new RoutedSpeechEngine(selector), transcoder),
    transcoder,
    models,
  };
}

/** The Gateway's routed `SpeechEngine` (contract entry point). */
export function createSpeechEngine(options: SpeechStackOptions = {}): SpeechEngine {
  return createSpeechStack(options).engine;
}
