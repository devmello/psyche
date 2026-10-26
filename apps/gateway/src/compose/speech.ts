import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getMessage, getSetting, setSetting } from "@psyche/db";
import { defaultDenyRead } from "@psyche/mcp-host";
import type { LibraryItem, NodeClient, NodeInfo } from "@psyche/protocol";
import { PsycheError, VOICE_CONVERSATION_SETTING_KEYS as VC } from "@psyche/protocol";
import {
  createSpeechHandlers,
  createSpeechStack,
  isRetiredVoiceRef,
  type LibrarySaveInput,
  type LibraryWriter,
  LocalProcessRunner,
  type MessageSource,
  NODE_SPEECH_CAPABILITIES,
  type ProcessRunner,
  ReadAloudService,
  SPEECH_METHODS,
  type SpeechCaller,
  VoiceCatalog,
  VoiceConversationManager,
  type VoiceConversationSettings,
  VoiceMemoService,
  VoiceSessionManager,
} from "@psyche/speech";
import { ulid } from "ulid";
import type { Call, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import { surfaceOf } from "./handlers.ts";
import { indexSavedAudio } from "./library.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";
import { chatVoiceTurns } from "./voice-turns.ts";

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
    try {
      this.#onSaved?.(item);
    } catch (err) {
      await rm(join(this.#root, rel), { force: true }).catch(() => undefined);
      throw err;
    }
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
    migrateRetiredVoices(services);
    const prefix = speechPrefix(setup, services);
    const runner =
      prefix === undefined
        ? warnUnsandboxed(new LocalProcessRunner(), services)
        : new LocalProcessRunner({ prefix });
    const stack = createSpeechStack({
      home: services.home,
      runner,
      macNode: speechNode(() => gateway),
      personalVoice: () => getSetting(db, "speech.tts.personalVoice")?.value === true,
    });
    const toDevice = (deviceId: string, e: { event: string; payload: unknown }) =>
      gateway?.bus.publishToDevice(deviceId, e.event as never, e.payload as never);
    const library = new FsAudioLibrary(services.home, undefined, indexSavedAudio(db));
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
    const setting = (key: string): unknown => getSetting(db, key)?.value;
    const conversations = new VoiceConversationManager({
      selector: stack.selector,
      tts: stack.engine,
      turns: chatVoiceTurns(() => gateway),
      emit: toDevice,
      enabled: () => setting(VC.enabled) === true,
      settings: () => conversationSettings(setting),
      approvals: voiceApprovals(services),
    });
    const fns = createSpeechHandlers({
      voice,
      memos,
      readAloud,
      catalog: new VoiceCatalog(stack.selector),
      conversations,
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
    const onDisconnect = (deviceId: string) => {
      voice.cancelAll(deviceId);
      conversations.endForDevice(deviceId, "disconnected");
    };
    return {
      handlers,
      start(gw) {
        gateway = gw;
        gw.context.deviceDisconnected.add(onDisconnect);
      },
      stop() {
        gateway?.context.deviceDisconnected.delete(onDisconnect);
        voice.cancelAll();
        conversations.endAll();
        gateway = null;
      },
    };
  };
}

/** Settings that hold an `<engine>:<voice>` ref the owner picked. */
export const VOICE_REF_SETTINGS = [VC.voice, "speech.tts.voice"] as const;

/**
 * Moves an owner who picked the OpenAI cloud voice to the default voice, once, with a notice:
 * OpenAI's TTS endpoints shut down on 2027-01-06 and the engine was removed
 * (docs/voice/voice-mode-2026.md §2, #691). `null` means "best installed voice for the language".
 */
export function migrateRetiredVoices(
  services: Pick<ComposeServices, "db" | "notifier" | "logger">,
): string[] {
  const moved: string[] = [];
  for (const key of VOICE_REF_SETTINGS) {
    if (!isRetiredVoiceRef(getSetting(services.db, key)?.value)) continue;
    setSetting(services.db, key, null);
    moved.push(key);
  }
  if (moved.length > 0) {
    services.notifier
      .notify({
        kind: "system",
        route: "/settings/voice",
        title: "Psyche's voice changed",
        body: "OpenAI is retiring the voice you picked, so Psyche now uses the default voice. You can choose another in Settings → Voice & dictation.",
        dedupeKey: "speech:voice-retired:openai",
      })
      .catch((err) =>
        services.logger?.log("warn", "voice migration notice failed", {
          code: PsycheError.from(err).code,
        }),
      );
  }
  return moved;
}

/**
 * Approvals answered by voice (spec §4.6), through the broker exactly as the device's own card:
 * this device's single-use surface token, scope `once`, `via: "voice"`. The conversation has
 * already applied the tiers; the broker re-checks the token, expiry, binding and presence.
 */
export function voiceApprovals(services: ComposeServices) {
  return {
    async answer(input: {
      approvalId: string;
      deviceId: string;
      decision: "approve" | "deny";
      utterance: string;
    }): Promise<void> {
      const surface = surfaceOf(services.db, input.deviceId);
      const answerToken = services.approvalTokens.tokenFor(input.approvalId, surface);
      if (answerToken === undefined) {
        throw new PsycheError("forbidden", "this device has no card for that approval");
      }
      const approval = await services.rawBroker.answer({
        approvalId: input.approvalId,
        answerToken,
        decision: input.decision,
        scope: "once",
        via: "voice",
        decidedBy: { deviceId: input.deviceId, surface },
      });
      if (approval.status === "pending") {
        throw new PsycheError("conflict", "the approval was not decided");
      }
    },
  };
}

/** The owner's voice conversation settings (spec §6.4), defaulted where unset or invalid. */
export function conversationSettings(
  setting: (key: string) => unknown,
): Partial<VoiceConversationSettings> {
  const out: Partial<VoiceConversationSettings> = {};
  const speak = setting(VC.speak);
  if (speak === "brief" || speak === "full") out.speak = speak;
  const narrate = setting(VC.narrate);
  if (narrate === "off" || narrate === "brief" || narrate === "steps") out.narrate = narrate;
  const approvals = setting(VC.approvals);
  if (approvals === "off" || approvals === "write" || approvals === "write_destructive") {
    out.approvals = approvals;
  }
  const pause = setting(VC.pauseMs);
  if (typeof pause === "number" && Number.isFinite(pause)) {
    out.pauseMs = Math.min(2_000, Math.max(500, Math.round(pause)));
  }
  return out;
}
