import type { Voice } from "@psyche/protocol";
import { type EngineLocation, parseVoiceRef, type SpeechEngineSelector } from "./policy.ts";

/**
 * Voice selection per persona (feature Q3: "voice selection per persona", UI §3.17 persona
 * editor, Settings → Voice & dictation). Lists every voice the configured synthesis engines
 * offer right now as `<engine>:<voice>` references, the form IDENTITY.md's `voice:` field and
 * `speech.readAloud {voice}` take. Cloud voices are listed only when the owner put their engine
 * in `speech.tts.order` (they send text off the machine); nothing here synthesizes.
 */

export interface VoiceInfo extends Voice {
  /** `<engine>:<voice>`: what goes into IDENTITY.md `voice:` or `speech.readAloud {voice}`. */
  ref: string;
  engine: string;
  location: EngineLocation;
  /** `true` for the voice the settings (or the persona) currently select. */
  default: boolean;
  /** Personal Voice on the Mac: Apple's terms allow non-commercial use only. */
  nonCommercial?: boolean;
}

export interface VoiceCatalogResult {
  voices: VoiceInfo[];
  /** The resolved default `<engine>:<voice>`, or `null` when no engine can synthesize. */
  default: string | null;
  /** Engines in order that could not list voices (offline node, missing model). */
  unavailable: string[];
}

export class VoiceCatalog {
  readonly #selector: SpeechEngineSelector;

  constructor(selector: SpeechEngineSelector) {
    this.#selector = selector;
  }

  /**
   * Voices of every available synthesis engine, in `speech.tts.order` (persona engine first).
   * `personaVoice` is the IDENTITY.md `voice:` of the persona being edited, if any.
   */
  async list(options: { personaVoice?: string } = {}): Promise<VoiceCatalogResult> {
    const wanted = parseVoiceRef(options.personaVoice ?? this.#selector.settings.tts.voice);
    const statuses = await this.#selector.explain({
      purpose: "synthesize",
      ...(options.personaVoice === undefined ? {} : { voice: options.personaVoice }),
    });
    const voices: VoiceInfo[] = [];
    const unavailable: string[] = [];
    for (const status of statuses) {
      const entry = this.#selector.entry(status.id);
      if (entry === undefined || !entry.supports.synthesize) continue;
      if (!status.eligible || entry.engine === undefined) {
        unavailable.push(status.id);
        continue;
      }
      let list: Voice[];
      try {
        list = await entry.engine.voices();
      } catch {
        unavailable.push(status.id);
        continue;
      }
      for (const v of list) {
        const info: VoiceInfo = {
          ...v,
          ref: `${status.id}:${v.id}`,
          engine: status.id,
          location: entry.location,
          default: false,
        };
        const extra = v as Voice & { nonCommercial?: boolean };
        if (extra.nonCommercial === true) info.nonCommercial = true;
        voices.push(info);
      }
    }
    // The default is the configured voice when present; else the first voice of the first engine.
    const def =
      voices.find(
        (v) => v.id === wanted.voice && (wanted.engine === undefined || v.engine === wanted.engine),
      ) ?? voices[0];
    for (const v of voices) v.default = v === def;
    return { voices, default: def?.ref ?? null, unavailable };
  }

  /**
   * `true` when `voiceRef` (or, without one, the configured default) resolves to a voice marked
   * non-commercial (Apple Personal Voice). For `ReadAloudService({nonCommercial})`.
   */
  async isNonCommercial(voiceRef?: string): Promise<boolean> {
    const r = await this.list(voiceRef === undefined ? {} : { personaVoice: voiceRef });
    return r.voices.find((v) => v.default)?.nonCommercial === true;
  }
}
