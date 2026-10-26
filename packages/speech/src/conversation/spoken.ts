import { markdownToSpeech } from "../readAloud.ts";

/**
 * What Psyche says out of a streaming answer (docs/voice/voice-mode-2026.md §4.5). The answer
 * arrives as text deltas. `SpokenText` turns them into speakable sentences as soon as each one
 * is complete, so the first sentence is synthesized while the model writes the second.
 *
 * - `brief` (default): the spoken lead only. That is the text up to the first blank line, capped
 *   at about 60 words. When more follows, "The rest is on screen." is added.
 * - `full`: the whole answer, up to 2 000 characters, then the same closing line.
 * - Never spoken: code blocks, table rows, headings' markup, raw URLs (`markdownToSpeech` turns a
 *   link into its text, and a bare URL into "link"). Markup is stripped, so quoted content can't
 *   steer the voice with SSML.
 */

export type SpeakLevel = "brief" | "full";

export const BRIEF_MAX_WORDS = 60;
export const FULL_MAX_CHARS = 2_000;
/** A sentence shorter than this waits for the next one, unless the answer ends. */
const MIN_SENTENCE_CHARS = 40;

export interface SpokenTextOptions {
  speak: SpeakLevel;
  /** Said when part of the answer is not spoken. */
  restOnScreen?: string;
}

export class SpokenText {
  readonly #speak: SpeakLevel;
  readonly #rest: string;
  #pending = "";
  #inCode = false;
  #lineStart = true;
  #spokenWords = 0;
  #spokenChars = 0;
  /** No more text will be spoken (the lead ended, or the cap was reached). */
  #closed = false;
  /** Text arrived that was not spoken. */
  #unsaid = false;

  constructor(options: SpokenTextOptions) {
    this.#speak = options.speak;
    this.#rest = options.restOnScreen ?? "The rest is on screen.";
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Feeds a delta; returns the sentences now complete and speakable. */
  push(delta: string): string[] {
    const out: string[] = [];
    for (const line of this.#lines(delta)) {
      if (this.#closed) {
        if (line.text.trim() !== "") this.#unsaid = true;
        continue;
      }
      if (line.fence) {
        this.#inCode = !this.#inCode;
        this.#unsaid = true;
        continue;
      }
      if (this.#inCode) {
        this.#unsaid = true;
        continue;
      }
      if (/^\s*\|/.test(line.text)) {
        this.#unsaid = true;
        continue;
      }
      if (line.complete && line.text.trim() === "") {
        // A blank line ends the spoken lead in brief mode.
        out.push(...this.#flush(true));
        if (this.#speak === "brief" && this.#spokenWords > 0) this.#closed = true;
        continue;
      }
      this.#pending += line.complete ? `${line.text}\n` : line.text;
      out.push(...this.#flush(false));
    }
    return out;
  }

  /** The answer ended: the rest of the pending text, and the closing line if anything was cut. */
  finish(): string[] {
    const out = this.#closed ? [] : this.#flush(true);
    if (this.#pending.trim() !== "") this.#unsaid = true;
    this.#pending = "";
    if (this.#unsaid && this.#spokenWords > 0) out.push(this.#rest);
    this.#closed = true;
    return out;
  }

  /** Splits the delta into lines, remembering a partial line across deltas. */
  #lines(delta: string): { text: string; complete: boolean; fence: boolean }[] {
    const parts = delta.split("\n");
    const out: { text: string; complete: boolean; fence: boolean }[] = [];
    parts.forEach((text, i) => {
      const complete = i < parts.length - 1;
      const fence = this.#lineStart && /^\s*```/.test(text);
      out.push({ text, complete, fence });
      this.#lineStart = complete;
    });
    return out;
  }

  /** Takes complete sentences off `#pending`; with `all`, everything left. */
  #flush(all: boolean): string[] {
    const out: string[] = [];
    for (;;) {
      const m = /[.!?…](["')\]]*)(\s+)/.exec(this.#pending);
      let cut = -1;
      if (m !== null) {
        const end = m.index + m[0].length;
        if (end >= MIN_SENTENCE_CHARS || all) cut = end;
        else {
          // Too short alone: look for the next boundary after the minimum length.
          const re = /[.!?…](["')\]]*)(\s+)/g;
          re.lastIndex = MIN_SENTENCE_CHARS;
          const next = re.exec(this.#pending);
          if (next !== null) cut = next.index + next[0].length;
        }
      }
      if (cut < 0) break;
      const sentence = this.#pending.slice(0, cut);
      this.#pending = this.#pending.slice(cut);
      if (!this.#say(sentence, out)) return out;
    }
    if (all && this.#pending.trim() !== "") {
      const rest = this.#pending;
      this.#pending = "";
      this.#say(rest, out);
    }
    return out;
  }

  /** Adds one sentence if the policy allows it; `false` once the spoken part is over. */
  #say(raw: string, out: string[]): boolean {
    const text = markdownToSpeech(raw);
    if (text === "") return true;
    const words = text.split(/\s+/).filter(Boolean).length;
    if (
      this.#speak === "brief" &&
      this.#spokenWords > 0 &&
      this.#spokenWords + words > BRIEF_MAX_WORDS
    ) {
      this.#closed = true;
      this.#unsaid = true;
      return false;
    }
    if (this.#speak === "full" && this.#spokenChars + text.length > FULL_MAX_CHARS) {
      this.#closed = true;
      this.#unsaid = true;
      return false;
    }
    out.push(text);
    this.#spokenWords += words;
    this.#spokenChars += text.length;
    return true;
  }
}
