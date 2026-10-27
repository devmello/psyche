import type { NodeClient, SpeechEngine } from "@psyche/protocol";
import { DecodingSpeechEngine } from "./adapters.ts";
import { DEFAULT_WHISPER_MODEL, MODEL_CATALOG } from "./catalog.ts";
import { NODE_SPEECH_CAPABILITIES, NodeSpeechEngine } from "./engines/node.ts";
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
export * from "./engines/node.ts";
export * from "./engines/openai-audio.ts";
export * from "./engines/web.ts";
export * from "./engines/whisper.ts";
export * from "./handlers.ts";
export * from "./library.ts";
export * from "./memo.ts";
export * from "./models.ts";
export * from "./policy.ts";
export * from "./process.ts";
export * from "./queue.ts";
export * from "./stream.ts";
export * from "./transcode/caf.ts";
export * from "./transcode/ffmpeg.ts";
export * from "./transcode/formats.ts";
export * from "./vocabulary.ts";
export * from "./voice.ts";

export interface SpeechStackOptions {
  /** `$PSYCHE_HOME`; models live under `models/`. */
  home?: string;
  settings?: SpeechSettings;
  /** The Mac node to use now (paired and online), if any. */
  macNode?: () => NodeClient | undefined | Promise<NodeClient | undefined>;
  /** Runner for ffmpeg and whisper-cli (wrap with `srt` / the sandbox in the Gateway). */
  runner?: ProcessRunner;
  whisper?: { binary?: string; model?: string; threads?: number };
  ffmpeg?: { ffmpeg?: string; ffprobe?: string };
}

export interface SpeechStack {
  selector: SpeechEngineSelector;
  /** Per-call routed engine for the Gateway's own use (channels); decodes compressed input. */
  engine: SpeechEngine;
  transcoder: VoiceNoteTranscoder;
  models: ModelManager;
}

/**
 * Wires the default engines (feature Q1/Q3, ADR-014): Mac node → whisper.cpp → Web Speech for
 * transcription. Psyche does not speak, so there is no synthesis. Nothing is
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
    const node = new NodeSpeechEngine({ node: macNode });
    selector.register({
      id: "mac-node",
      location: "node",
      supports: { transcribe: true, stream: true },
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
    supports: { transcribe: true, stream: true },
    engine: whisper,
    available: () => whisper.available(),
  });
  selector.register(WEB_SPEECH_ENTRY);

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
