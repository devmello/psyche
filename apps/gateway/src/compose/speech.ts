import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deleteSettings, getLibraryItem } from "@psyche/db";
import { defaultDenyRead } from "@psyche/mcp-host";
import type { LibraryItem, NodeClient, NodeInfo } from "@psyche/protocol";
import { PsycheError } from "@psyche/protocol";
import {
  createSpeechHandlers,
  createSpeechStack,
  type LibrarySaveInput,
  type LibraryTranscriptWriter,
  type LibraryWriter,
  LocalProcessRunner,
  type MeetingRecordingInput,
  NODE_SPEECH_CAPABILITIES,
  NodeSpeechEngine,
  type ProcessRunner,
  SPEECH_METHODS,
  type SpeechCaller,
  VoiceMemoService,
  VoiceSessionManager,
} from "@psyche/speech";
import { ulid } from "ulid";
import type { Call, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import { surfaceOf } from "./handlers.ts";
import { indexSavedAudio } from "./library.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Speech to text (S17, features Q1, Q2, Q4) mounted on the Gateway: `voice.*` dictation and
 * `voice.memo.save`. The default engine is the Mac helper's (SpeechAnalyzer) on the newest
 * connected `mac-helper` node that offers `speech.*`; whisper.cpp joins when its model is
 * installed. Psyche does not speak: there is no synthesis. Segment events go to the requesting
 * device only; a device's dictation sessions end when its last connection closes.
 */

export interface SpeechSetup {
  /**
   * argv prefix for ffmpeg / whisper-cli, e.g. `["srt", "--settings", <path>, "--"]` (security
   * §5.3). From `PSYCHE_SPEECH_RUNNER_PREFIX` (space-separated) in `speechSetupFromEnv`.
   */
  runnerPrefix?: string[];
  /**
   * `srt` (`PSYCHE_SRT_PATH`, as for stdio MCP servers): without an explicit prefix, ffmpeg and
   * whisper-cli run under it with `speechSrtSettings` (security §5.3).
   */
  srtPath?: string;
}

export function speechSetupFromEnv(env: NodeJS.ProcessEnv = process.env): SpeechSetup {
  const prefix = env.PSYCHE_SPEECH_RUNNER_PREFIX?.trim();
  if (prefix) return { runnerPrefix: prefix.split(/\s+/) };
  return env.PSYCHE_SRT_PATH ? { srtPath: env.PSYCHE_SRT_PATH } : {};
}

/**
 * srt settings for the speech helpers (security §5.3): reads of the secrets (vault, state,
 * audit, security, browser profiles, the Library, backups and the usual credential stores)
 * denied, while models stay readable; writes only to the temp directory, where the speech
 * package makes its per-call scratch directories; no network; the escape hatches pinned off.
 */
export function speechSrtSettings(
  home: string,
  scratch: string = tmpdir(),
): Record<string, unknown> {
  const secrets = [
    "vault",
    "state",
    "audit",
    "security",
    "browser",
    "library",
    "workspace",
    "backups",
    "mcp",
  ].map((d) => join(home, d));
  return {
    filesystem: {
      denyRead: [...new Set([...defaultDenyRead(home).filter((p) => p !== home), ...secrets])],
      allowRead: [],
      allowWrite: [scratch],
      denyWrite: [home],
    },
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: false,
    },
    enableWeakerNestedSandbox: false,
    allowNestedUserNamespaces: false,
    enableWeakerNetworkIsolation: false,
    allowAppleEvents: false,
  };
}

const UNSANDBOXED_HINT =
  "set PSYCHE_SRT_PATH so ffmpeg and whisper-cli run under srt (security §5.3)";

/** The runner prefix: explicit, srt with the speech profile, or none. */
function speechPrefix(setup: SpeechSetup, services: ComposeServices): string[] | undefined {
  if (setup.runnerPrefix !== undefined) return setup.runnerPrefix;
  if (setup.srtPath === undefined) {
    // The Mac helper does the owner's speech; nothing runs here until a local tool is used (#540).
    services.logger?.log("debug", "speech.unsandboxed", { hint: UNSANDBOXED_HINT });
    return undefined;
  }
  const dir = join(services.home, "speech");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, "srt-settings.json");
  writeFileSync(file, `${JSON.stringify(speechSrtSettings(services.home), null, 2)}\n`, {
    mode: 0o600,
  });
  return [setup.srtPath, "--settings", file, "--"];
}

/** Warns once, when ffmpeg or whisper-cli first runs on this host without srt (#540). */
export function warnUnsandboxed(inner: ProcessRunner, services: ComposeServices): ProcessRunner {
  let warned = false;
  return {
    run(request) {
      if (!warned) {
        warned = true;
        services.logger?.log("warn", "speech.unsandboxed", {
          tool: basename(request.argv[0] ?? ""),
          hint: UNSANDBOXED_HINT,
        });
      }
      return inner.run(request);
    },
  };
}

/**
 * The newest live mac-helper node that offers speech (it connects after the Gateway boots):
 * `capability` is `speech.transcribe_stream` by default, `speech.transcribe_file` for recordings.
 */
export function speechNode(
  gateway: () => Gateway | null,
  capability: string = NODE_SPEECH_CAPABILITIES.transcribeStream,
): () => NodeClient | undefined {
  return () => {
    const nodes = gateway()?.context.nodes;
    if (!nodes) return undefined;
    const offers = (n: NodeInfo) =>
      n.kind === "mac-helper" && n.capabilities.some((c) => c.name === capability);
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
 * Stores clips and recordings under `$PSYCHE_HOME/library/audio/` (0700 / 0600) and hands each
 * saved item to `onSaved` (the Gateway indexes it in `library_items`; a failure removes the file);
 * `untrusted` recordings are marked quarantined (data model §9).
 */
export class FsAudioLibrary implements LibraryWriter {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #onSaved: ((item: LibraryItem) => void) | undefined;

  constructor(
    home: string,
    now: () => Date = () => new Date(),
    onSaved?: (item: LibraryItem) => void,
  ) {
    this.#root = join(home, "library");
    this.#now = now;
    this.#onSaved = onSaved;
  }

  async saveAudio(file: LibrarySaveInput): Promise<LibraryItem> {
    const id = ulid();
    const ext = EXT[file.mime] ?? "bin";
    const rel = join("audio", `${id}.${ext}`);
    const dir = join(this.#root, "audio");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(this.#root, rel), file.data, { mode: 0o600 });
    await chmod(join(this.#root, rel), 0o600);
    const extractRef =
      file.textExtract === undefined ? null : await writeExtract(this.#root, id, file.textExtract);
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
      textExtractRef: extractRef,
      createdAt: this.#now().toISOString(),
    };
    if (file.provenance === "untrusted") item.quarantined = true;
    try {
      this.#onSaved?.(item);
    } catch (err) {
      await rm(join(this.#root, rel), { force: true }).catch(() => undefined);
      if (extractRef !== null) {
        await rm(join(this.#root, extractRef), { force: true }).catch(() => undefined);
      }
      throw err;
    }
    return item;
  }
}

/** Writes `extracts/<id>.txt` under the Library root (0700 / 0600); returns its relative path. */
async function writeExtract(root: string, id: string, text: string): Promise<string> {
  const rel = join("extracts", `${id}.txt`);
  await mkdir(join(root, "extracts"), { recursive: true, mode: 0o700 });
  await writeFile(join(root, rel), text, { mode: 0o600 });
  await chmod(join(root, rel), 0o600);
  return rel;
}

/**
 * A recording already in the Library gets its meeting transcript as its text extract
 * (docs/workflows/mail-and-meetings-2026.md §4.6 step 1); other people's words quarantine it.
 */
export function libraryTranscripts(
  db: ComposeServices["db"],
  home: string,
): LibraryTranscriptWriter {
  return {
    async setTextExtract(itemId, extract) {
      if (getLibraryItem(db, itemId) === undefined) {
        throw new PsycheError("not_found", `library item ${itemId} not found`);
      }
      const rel = await writeExtract(join(home, "library"), itemId, extract.text);
      db.sqlite
        .prepare(
          `UPDATE library_items SET text_extract_ref = ?${extract.provenance === "untrusted" ? ", quarantined = 1" : ""} WHERE id = ?`,
        )
        .run(rel, itemId);
      return getLibraryItem(db, itemId) as LibraryItem;
    },
  };
}

/**
 * What post-meeting notes call to transcribe a recording on the Mac (`MeetingTranscriber` in
 * `@psyche/proactive`): `VoiceMemoService.ingestMeeting` with the Library's transcript writer.
 */
export interface MeetingIngest {
  ingestMeeting(input: MeetingRecordingInput): ReturnType<VoiceMemoService["ingestMeeting"]>;
  /** Whether a transcriber for long recordings is online now (a helper offering the file path). */
  available(): boolean;
}

export function composeSpeech(setup: SpeechSetup = {}) {
  return (services: ComposeServices): ComposedPart & { meetings: MeetingIngest } => {
    let gateway: Gateway | null = null;
    const { db } = services;
    removeStaleSpeechSettings(services);
    const prefix = speechPrefix(setup, services);
    const runner =
      prefix === undefined
        ? warnUnsandboxed(new LocalProcessRunner(), services)
        : new LocalProcessRunner({ prefix });
    const stack = createSpeechStack({
      home: services.home,
      runner,
      macNode: speechNode(() => gateway),
    });
    const toDevice = (deviceId: string, e: { event: string; payload: unknown }) =>
      gateway?.bus.publishToDevice(deviceId, e.event as never, e.payload as never);
    const library = new FsAudioLibrary(services.home, undefined, indexSavedAudio(db));
    const voice = new VoiceSessionManager({ selector: stack.selector, emit: toDevice });
    // Long recordings are transcribed where they lie on the Mac (`speech.transcribe_file`, §4.6).
    const filesNode = speechNode(() => gateway, NODE_SPEECH_CAPABILITIES.transcribeFile);
    const files = new NodeSpeechEngine({ node: filesNode });
    const memos = new VoiceMemoService({
      engine: stack.engine,
      library,
      transcoder: stack.transcoder,
      files,
    });
    const transcripts = libraryTranscripts(db, services.home);
    const fns = createSpeechHandlers({ voice, memos });

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
      meetings: {
        ingestMeeting: (input) => memos.ingestMeeting(input, transcripts),
        available: () => filesNode() !== undefined,
      },
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

/**
 * Settings of the spoken-reply features that were removed: Psyche does not speak, so a voice, its
 * speed, narration, barge-in, spoken approvals, captions, the spoken brief, the `voice` model
 * role and the synthesis order mean nothing. Kept: `voice.conversation.{enabled, key, reviewBeforeSend}`.
 */
export const STALE_SPEECH_SETTINGS = [
  "voice.conversation.voice",
  "voice.conversation.rate",
  "voice.conversation.speak",
  "voice.conversation.narrate",
  "voice.conversation.bargeIn",
  "voice.conversation.approvals",
  "voice.conversation.language",
  "voice.conversation.captions",
  "voice.conversation.pauseMs",
  "voice.conversation.brief",
  "voice.conversation.mode",
  "voice.conversation.start",
  "voice.conversation.reply",
  "speech.tts.order",
  "speech.tts.voice",
  "speech.tts.personalVoice",
  "models.voice",
] as const;

/** Removes the stale spoken-reply settings (idempotent); returns the keys that were present. */
export function removeStaleSpeechSettings(
  services: Pick<ComposeServices, "db" | "logger">,
): string[] {
  const removed = deleteSettings(services.db, STALE_SPEECH_SETTINGS);
  if (removed.length > 0)
    services.logger?.log("info", "speech.settings_removed", { removed: removed.join(",") });
  return removed;
}
