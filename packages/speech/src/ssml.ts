/**
 * SSML-lite (feature Q3): the few controls read-aloud and voice notes need, parsed leniently.
 * Unknown tags are dropped and their text kept; malformed markup degrades to plain text.
 *
 * - `<break time="500ms"/>` or `time="1.5s"` (capped at 5 s)
 * - `<prosody rate="slow|medium|fast|x-slow|x-fast|0.8|120%">…</prosody>` (0.5–2.0)
 * - `<say-as interpret-as="characters">ABC</say-as>` spells letters out
 * - `<emphasis>`, `<speak>` are accepted; `</p>` and `</s>` add short pauses
 */

export type SpeechPart =
  | { kind: "text"; text: string; rate: number }
  | { kind: "break"; ms: number };

export const MAX_BREAK_MS = 5_000;
const RATE_WORDS: Record<string, number> = {
  "x-slow": 0.6,
  slow: 0.8,
  medium: 1,
  default: 1,
  fast: 1.2,
  "x-fast": 1.45,
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e] ?? "");
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m?.[2] ?? m?.[3];
}

const clampRate = (r: number) => Math.min(2, Math.max(0.5, r));

export function parseRate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  const word = RATE_WORDS[v];
  if (word !== undefined) return word;
  const pct = /^(\d+(?:\.\d+)?)%$/.exec(v);
  const n = pct !== null ? Number(pct[1]) / 100 : Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return clampRate(n);
}

export function parseBreak(value: string | undefined): number {
  if (value === undefined) return 300;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s)$/i.exec(value.trim());
  if (m === null) return 300;
  const ms = Number(m[1]) * ((m[2] ?? "ms").toLowerCase() === "s" ? 1000 : 1);
  return Math.min(MAX_BREAK_MS, Math.max(0, Math.round(ms)));
}

/** `true` when the input looks like SSML-lite rather than plain text. */
export function looksLikeSsml(text: string): boolean {
  return /<\s*\/?\s*(speak|break|prosody|say-as|emphasis|p|s)\b/i.test(text);
}

/** Parses SSML-lite (or plain text) into text runs and pauses. */
export function parseSsmlLite(input: string, baseRate = 1): SpeechPart[] {
  if (!looksLikeSsml(input)) {
    const text = input.replace(/\s+/g, " ").trim();
    return text === "" ? [] : [{ kind: "text", text, rate: baseRate }];
  }
  const parts: SpeechPart[] = [];
  const rates: number[] = [baseRate];
  let spell = 0;
  const pushText = (raw: string) => {
    let text = decodeEntities(raw);
    if (spell > 0) text = ` ${text.replace(/\s+/g, "").split("").join(" ")} `;
    if (text === "") return;
    const rate = rates.at(-1) ?? baseRate;
    const last = parts.at(-1);
    if (last?.kind === "text" && last.rate === rate) last.text += text;
    else if (text.trim() !== "") parts.push({ kind: "text", text, rate });
  };
  const pushBreak = (ms: number) => {
    if (ms <= 0) return;
    const last = parts.at(-1);
    if (last?.kind === "break") last.ms = Math.min(MAX_BREAK_MS, last.ms + ms);
    else parts.push({ kind: "break", ms });
  };
  let pos = 0;
  for (const m of input.matchAll(/<\s*(\/)?\s*([a-zA-Z-]+)([^>]*?)(\/)?\s*>/g)) {
    pushText(input.slice(pos, m.index));
    pos = m.index + m[0].length;
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    const selfClosing = m[4] === "/";
    const tag = m[3] ?? "";
    if (name === "break") {
      pushBreak(parseBreak(attr(tag, "time")));
    } else if (name === "prosody" && !selfClosing) {
      if (closing) {
        if (rates.length > 1) rates.pop();
      } else {
        const r = parseRate(attr(tag, "rate")) ?? 1;
        rates.push(clampRate(r * (rates.at(-1) ?? baseRate)));
      }
    } else if (name === "say-as" && !selfClosing) {
      if (closing) spell = Math.max(0, spell - 1);
      else if (/^(characters|spell-out|letters)$/i.test(attr(tag, "interpret-as") ?? "")) spell++;
    } else if ((name === "p" || name === "s") && closing) {
      pushBreak(name === "p" ? 400 : 150);
    }
  }
  pushText(input.slice(pos));
  const out = parts
    .map((p) => (p.kind === "text" ? { ...p, text: p.text.replace(/\s+/g, " ").trim() } : p))
    .filter((p) => p.kind === "break" || p.text !== "");
  while (out[0]?.kind === "break") out.shift();
  while (out.at(-1)?.kind === "break") out.pop();
  return out;
}

/** Plain text of an SSML-lite document (for transcripts and Library item names). */
export function ssmlToText(input: string): string {
  return parseSsmlLite(input)
    .flatMap((p) => (p.kind === "text" ? [p.text] : []))
    .join(" ");
}

/**
 * Splits text into sentence-sized chunks of at most `maxChars` (Kokoro takes ≤ 510 phoneme
 * tokens per call; ~300 characters of English stays under that).
 */
export function splitSentences(text: string, maxChars = 300): string[] {
  const sentences = text.match(/[^.!?;…]+[.!?;…]*["')\]]*\s*/g) ?? [text];
  const out: string[] = [];
  for (const raw of sentences) {
    let rest = raw.trim();
    while (rest.length > maxChars) {
      // Long run-on: break at a comma or space inside the window.
      const window = rest.slice(0, maxChars);
      const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" "));
      const at = cut > maxChars / 3 ? cut + 1 : maxChars;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest !== "") out.push(rest);
  }
  return out;
}
