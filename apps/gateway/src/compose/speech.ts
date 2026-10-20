import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getMessage, getSetting } from "@psyche/db";
import type { LibraryItem, NodeClient, NodeInfo } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import {
  createSpeechHandlers,
  createSpeechStack,
  type LibrarySaveInput,
  type LibraryWriter,
  LocalProcessRunner,
  type MessageSource,
  NODE_SPEECH_CAPABILITIES,
  ReadAloudService,
  SPEECH_METHODS,
  type SpeechCaller,
  VoiceCatalog,
  VoiceMemoService,
  VoiceSessionManager,
} from "@psyche/speech";
import { ulid } from "ulid";
import type { Call, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import { surfaceOf } from "./handlers.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Speech (S17, features Q1–Q3) mounted on the Gateway: `voice.*`, `voice.memo.save`,
 * `speech.readAloud`, `speech.voices`. The default engine is the Mac helper's
 * (SpeechAnalyzer, AVSpeechSynthesizer, Personal Voice) on the newest connected `mac-helper`
 * node that offers `speech.*`; whisper.cpp and Kokoro join when their models are installed.
 * Audio events go to the requesting device only; a device's dictation sessions end when its last
 * connection closes.
 */

export interface SpeechSetup {
  /**
   * argv prefix for ffmpeg / whisper-cli, e.g. `["srt", "--settings", <path>, "--"]` (security
   * §5.3). From `PSYCHE_SPEECH_RUNNER_PREFIX` (space-separated) in `speechSetupFromEnv`.
   */
  runnerPrefix?: string[];
}

export function speechSetupFromEnv(env: NodeJS.ProcessEnv = process.env): SpeechSetup {
  const prefix = env.PSYCHE_SPEECH_RUNNER_PREFIX?.trim();
  return prefix ? { runnerPrefix: prefix.split(/\s+/) } : {};
}

/** The newest live mac-helper node that offers speech (it connects after the Gateway boots). */
export function speechNode(gateway: () => Gateway | null): () => NodeClient | undefined {
  return () => {
    const nodes = gateway()?.context.nodes;
    if (!nodes) return undefined;
    const offers = (n: NodeInfo) =>
      n.kind === "mac-helper" &&
      n.capabilities.some((c) => c.name === NODE_SPEECH_CAPABILITIES.transcribeStream);
    const node = nodes
      .list()
      .filter((n) => offers(n) && nodes.isLive(n.id))
      .at(-1);
    return node === undefined ? undefined : nodes.client(node.id);
  };
}

const EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/webm": "webm",
};

/**
 * Stores clips and recordings under `$PSYCHE_HOME/library/audio/` (0700 / 0600) until the Library
 * owner ships a store; `untrusted` recordings are marked quarantined (data model §9).
 */
export class FsAudioLibrary implements LibraryWriter {
  readonly #root: string;
  readonly #now: () => Date;

  constructor(home: string, now: () => Date = () => new Date()) {
    this.#root = join(home, "library");
    this.#now = now;
  }

  async saveAudio(file: LibrarySaveInput): Promise<LibraryItem> {
    const id = ulid();
    const ext = EXT[file.mime] ?? "bin";
    const rel = join("audio", `${id}.${ext}`);
    const dir = join(this.#root, "audio");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.#root, rel), file.data, { mode: 0o600 });
    await chmod(join(this.#root, rel), 0o600);
    const item: LibraryItem = {
      id,
      kind: file.kind ?? "audio",
      name: file.name,
      mime: file.mime,
      path: rel,
      size: file.data.byteLength,
      sha256: `sha256:${createHash("sha256").update(file.data).digest("hex")}`,
      origin: file.origin ?? "agent",
      threadId: file.threadId,
      taskId: null,
      tags: [...file.tags],
      textExtractRef: null,
      createdAt: this.#now().toISOString(),
    };
    if (file.provenance === "untrusted") item.quarantined = true;
    return item;
  }
}

/** Message text for read-aloud; the owner's devices may read every thread. */
export function dbMessageSource(db: ComposeServices["db"]): MessageSource {
  return {
    async get(messageId) {
      const m = getMessage(db, messageId);
      if (!m) throw new PsycheError("not_found", `message ${messageId} not found`);
      const text = m.blocks
        .flatMap((b) => (b.type === "text" ? [b.md] : b.type === "wrap_up" ? [b.recap] : []))
        .join("\n\n")
        .trim();
      if (text === "") throw new PsycheError("invalid_params", "that message has no text to read");
      return { text, threadId: m.threadId };
    },
  };
}

export function composeSpeech(setup: SpeechSetup = {}) {
  return (services: ComposeServices): ComposedPart => {
    let gateway: Gateway | null = null;
    const { db } = services;
    const runner = new LocalProcessRunner(
      setup.runnerPrefix === undefined ? {} : { prefix: setup.runnerPrefix },
    );
    const stack = createSpeechStack({
      home: services.home,
      runner,
      macNode: speechNode(() => gateway),
      personalVoice: () => getSetting(db, "speech.tts.personalVoice")?.value === true,
    });
    const toDevice = (deviceId: string, e: { event: string; payload: unknown }) =>
      gateway?.bus.publishToDevice(deviceId, e.event as never, e.payload as never);
    const library = new FsAudioLibrary(services.home);
    const voice = new VoiceSessionManager({ selector: stack.selector, emit: toDevice });
    const readAloud = new ReadAloudService({
      engine: stack.engine,
      transcoder: stack.transcoder,
      messages: dbMessageSource(db),
      library,
      emit: toDevice,
    });
    const memos = new VoiceMemoService({
      engine: stack.engine,
      library,
      transcoder: stack.transcoder,
    });
    const fns = createSpeechHandlers({
      voice,
      memos,
      readAloud,
      catalog: new VoiceCatalog(stack.selector),
    });

    const caller = (call: Call): SpeechCaller =>
      surfaceOf(db, call.identity.deviceId) === "web" ? "web" : "desktop";
    const handlers: Record<string, HandlerDef> = {};
    for (const method of SPEECH_METHODS) {
      const fn = fns[method] as (
        p: unknown,
        ctx: { deviceId: string; caller: SpeechCaller },
      ) => Promise<unknown>;
      handlers[method] = {
        run: (call: Call, params: never) =>
          fn(params, { deviceId: call.identity.deviceId, caller: caller(call) }),
      };
    }
    const onDisconnect = (deviceId: string) => voice.cancelAll(deviceId);
    return {
      handlers,
      start(gw) {
        gateway = gw;
        gw.context.deviceDisconnected.add(onDisconnect);
      },
      stop() {
        gateway?.context.deviceDisconnected.delete(onDisconnect);
        voice.cancelAll();
        gateway = null;
      },
    };
  };
}
