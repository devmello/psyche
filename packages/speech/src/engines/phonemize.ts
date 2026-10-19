import { createRequire } from "node:module";
import type { KokoroLanguage, Phonemizer } from "./kokoro.ts";

/**
 * Default G2P for Kokoro: the `phonemize` package (MIT, CMU-dictionary lookup plus rules,
 * no espeak-ng). Loaded through `require` because its ESM build imports JSON without import
 * attributes, which Node 24 rejects. Unknown words fall back to its letter rules, so rare names
 * may come out wrong; `addPronunciation` fixes them (the agent name goes in at startup).
 */
interface PhonemizeModule {
  toIPA(text: string, language?: string): string;
  addPronunciation(word: string, pronunciation: string, language?: string): void;
}

export class PhonemizePhonemizer implements Phonemizer {
  readonly name = "phonemize";
  #mod: PhonemizeModule | undefined;
  readonly #load: () => PhonemizeModule;

  constructor(load?: () => PhonemizeModule) {
    this.#load =
      load ?? (() => createRequire(import.meta.url)("phonemize") as unknown as PhonemizeModule);
  }

  #module(): PhonemizeModule {
    this.#mod ??= this.#load();
    return this.#mod;
  }

  async phonemize(text: string, language: KokoroLanguage): Promise<string> {
    return this.#module().toIPA(text, language);
  }

  /** Teaches a pronunciation (IPA), e.g. the agent's name. */
  addPronunciation(word: string, ipa: string, language: KokoroLanguage = "en-us"): void {
    this.#module().addPronunciation(word, ipa, language);
  }
}
