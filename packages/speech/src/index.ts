import { join } from "node:path";
import type { NodeClient, SpeechEngine } from "@psyche/protocol";
import { DecodingSpeechEngine } from "./adapters.ts";
import { DEFAULT_WHISPER_MODEL, MODEL_CATALOG } from "./catalog.ts";
import { NODE_SPEECH_CAPABILITIES, NodeSpeechEngine } from "./engines/node.ts";
import { WEB_SPEECH_ENTRY } from "./engines/web.ts";
import {
  isEnglishOnlyModel,
  type WhisperBackend,
  WhisperCliBackend,
  WhisperEngine,
} from "./engines/whisper.ts";
import {
  ManagedWhisperServerBackend,
  WhisperServerProcess,
  type WhisperServerProcessOptions,
} from "./engines/whisper-server-process.ts";
import { ModelManager, psycheHome } from "./models.ts";
import {
  defaultSpeechSettings,
  RoutedSpeechEngine,
  SpeechEngineSelector,
  type SpeechSettings,
} from "./policy.ts";
import type { ProcessRunner } from "./process.ts";
import { WhisperRuntime, whisperRuntimeFor } from "./runtime.ts";
import { VoiceNoteTranscoder } from "./transcode/ffmpeg.ts";
import { type WhisperDownloadEvent, WhisperInstaller } from "./whisper-setup.ts";

export * from "./adapters.ts";
export * from "./audio.ts";
export * from "./catalog.ts";
export * from "./engines/node.ts";
export * from "./engines/openai-audio.ts";
export * from "./engines/web.ts";
export * from "./engines/whisper.ts";
export * from "./engines/whisper-server-process.ts";
export * from "./handlers.ts";
export * from "./library.ts";
export * from "./memo.ts";
export * from "./models.ts";
export * from "./policy.ts";
export * from "./process.ts";
export * from "./queue.ts";
export * from "./runtime.ts";
export * from "./stream.ts";
export * from "./transcode/caf.ts";
export * from "./transcode/ffmpeg.ts";
export * from "./transcode/formats.ts";
export * from "./vocabulary.ts";
export * from "./voice.ts";
export * from "./whisper-setup.ts";

export interface SpeechStackOptions {
  /** `$PSYCHE_HOME`; models live under `models/`. */
  home?: string;
  settings?: SpeechSettings;
  /** The Mac node to use now (paired and online), if any. */
  macNode?: () => NodeClient | undefined | Promise<NodeClient | undefined>;
  /** Runner for ffmpeg and whisper-cli (wrap with `srt` / the sandbox in the Gateway). */
  runner?: ProcessRunner;
  whisper?: {
    binary?: string;
    model?: string;
    threads?: number;
    /** Managed whisper-server: stop after this long idle (default 5 min). */
    idleMs?: number;
    /** Managed whisper-server: registers its port with the Gateway's own ports. */
    onListening?: WhisperServerProcessOptions["onListening"];
    log?: WhisperServerProcessOptions["log"];
    /** Managed setup: download progress (`speech.model_download`). */
    onDownload?: (e: WhisperDownloadEvent) => void;
  };
  ffmpeg?: { ffmpeg?: string; ffprobe?: string };
  /** The host (default `process.platform` / `process.arch`): picks the default order and runtime. */
  platform?: NodeJS.Platform;
  arch?: string;
  /** For model and runtime downloads (tests). */
  fetch?: typeof fetch;
}

/**
 * whisper.cpp where Psyche provisions it (Windows): the pinned runtime, the server the Gateway
 * owns, and the owner's one-click download of both.
 */
export interface ManagedWhisper {
  engine: WhisperEngine;
  runtime: WhisperRuntime;
  process: WhisperServerProcess;
  installer: WhisperInstaller;
}

export interface SpeechStack {
  selector: SpeechEngineSelector;
  /** Per-call routed engine for the Gateway's own use (channels); decodes compressed input. */
  engine: SpeechEngine;
  transcoder: VoiceNoteTranscoder;
  models: ModelManager;
  /** Set where Psyche provisions whisper.cpp itself (Windows x64 / arm64). */
  whisper?: ManagedWhisper;
}

/**
 * Wires the default engines (feature Q1/Q3, ADR-014): Mac node → whisper.cpp → Web Speech for
 * transcription (on Windows whisper.cpp → the helper's SAPI → Web Speech). Psyche does not speak,
 * so there is no synthesis. Nothing is downloaded here; engines whose model is missing report
 * unavailable.
 */
export function createSpeechStack(options: SpeechStackOptions = {}): SpeechStack {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? psycheHome();
  const fetchOpt = options.fetch === undefined ? {} : { fetch: options.fetch };
  const models = new ModelManager({ home, catalog: MODEL_CATALOG, ...fetchOpt });
  const runnerOpt = options.runner === undefined ? {} : { runner: options.runner };
  const transcoder = new VoiceNoteTranscoder({ ...options.ffmpeg, ...runnerOpt });
  const selector = new SpeechEngineSelector(options.settings ?? defaultSpeechSettings(platform));

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

  const modelId = options.whisper?.model ?? DEFAULT_WHISPER_MODEL;
  const whisperModel = models.path(modelId);
  const runtimeSpec =
    options.whisper?.binary === undefined
      ? whisperRuntimeFor(platform, options.arch ?? process.arch)
      : undefined;
  let managed: Omit<ManagedWhisper, "engine"> | undefined;
  let backend: WhisperBackend;
  if (runtimeSpec !== undefined) {
    const runtime = new WhisperRuntime({ home, spec: runtimeSpec, ...fetchOpt });
    const w = options.whisper;
    const proc = new WhisperServerProcess({
      serverPath: runtime.serverPath,
      modelPath: whisperModel,
      workDir: join(home, "speech", "whisper-server"),
      ...(w?.threads === undefined ? {} : { threads: w.threads }),
      ...(w?.idleMs === undefined ? {} : { idleMs: w.idleMs }),
      ...(w?.onListening === undefined ? {} : { onListening: w.onListening }),
      ...(w?.log === undefined ? {} : { log: w.log }),
    });
    const installer = new WhisperInstaller({
      runtime,
      models,
      modelId,
      process: proc,
      ...(w?.onDownload === undefined ? {} : { onEvent: w.onDownload }),
    });
    managed = { runtime, process: proc, installer };
    backend = new ManagedWhisperServerBackend({ process: proc, ready: () => installer.ready() });
  } else {
    backend = new WhisperCliBackend({
      modelPath: whisperModel,
      ...(options.whisper?.binary === undefined ? {} : { binary: options.whisper.binary }),
      ...(options.whisper?.threads === undefined ? {} : { threads: options.whisper.threads }),
      ...runnerOpt,
    });
  }
  const whisper = new WhisperEngine({
    backend,
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

  const stack: SpeechStack = {
    selector,
    engine: new DecodingSpeechEngine(new RoutedSpeechEngine(selector), transcoder),
    transcoder,
    models,
  };
  if (managed !== undefined) stack.whisper = { ...managed, engine: whisper };
  return stack;
}

/** The Gateway's routed `SpeechEngine` (contract entry point). */
export function createSpeechEngine(options: SpeechStackOptions = {}): SpeechEngine {
  return createSpeechStack(options).engine;
}
