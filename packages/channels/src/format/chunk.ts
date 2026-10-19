import { type Flavor, renderMarkdown, renderPlain, splitBlocks } from "./markdown.ts";

/**
 * Splits a message into source pieces whose *rendered* length fits the channel limit (feature
 * N1). Pieces stay in the input format (the adapter renders them). Splits prefer paragraph, then
 * line, then word boundaries; code fences are closed and reopened around a split so every piece
 * renders on its own.
 */
export function chunkMessage(
  text: string,
  limit: number,
  options: { format?: "plain" | "markdown"; flavor?: Flavor } = {},
): string[] {
  if (limit < 16) throw new RangeError("chunk limit too small");
  const flavor = options.flavor ?? "plain";
  const markdown = options.format === "markdown";
  const render = (s: string) => (markdown ? renderMarkdown(s, flavor) : renderPlain(s, flavor));
  const fits = (s: string) => render(s).length <= limit;
  if (fits(text)) return text.trim() === "" ? [] : [text];

  const pieces: string[] = [];
  const units = markdown ? markdownUnits(text) : text.split(/\n{2,}/);
  for (const unit of units) {
    if (unit.trim() === "") continue;
    if (fits(unit)) pieces.push(unit);
    else pieces.push(...splitUnit(unit, fits));
  }

  const out: string[] = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current === "" ? piece : `${current}\n\n${piece}`;
    if (fits(joined)) current = joined;
    else {
      if (current !== "") out.push(current);
      current = piece;
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** Paragraphs of text, and each fenced code block as one unit (re-fenced). */
function markdownUnits(text: string): string[] {
  const units: string[] = [];
  for (const block of splitBlocks(text)) {
    if (block.kind === "code") units.push(fence(block.body, block.lang));
    else units.push(...block.body.split(/\n{2,}/));
  }
  return units;
}

function fence(body: string, lang?: string): string {
  return `\`\`\`${lang ?? ""}\n${body}\n\`\`\``;
}

function splitUnit(unit: string, fits: (s: string) => boolean): string[] {
  const code = /^```([\w+#.-]*)\n([\s\S]*)\n```$/.exec(unit);
  if (code !== null) {
    const lang = code[1] === "" ? undefined : code[1];
    return pack((code[2] ?? "").split("\n"), "\n", (s) => fits(fence(s, lang)), true).map((s) =>
      fence(s, lang),
    );
  }
  return pack(unit.split("\n"), "\n", fits, true);
}

/** Greedy packing of `parts` joined by `sep`; oversize parts are split by words, then hard-cut. */
function pack(
  parts: string[],
  sep: string,
  fits: (s: string) => boolean,
  splitWords: boolean,
): string[] {
  const out: string[] = [];
  let current: string | undefined;
  const push = (part: string) => {
    const joined = current === undefined ? part : `${current}${sep}${part}`;
    if (fits(joined)) current = joined;
    else {
      if (current !== undefined) out.push(current);
      current = part;
    }
  };
  for (const part of parts) {
    if (fits(part)) push(part);
    else {
      const sub =
        splitWords && /\s/.test(part)
          ? pack(part.split(/ +/), " ", fits, false)
          : hardCut(part, fits);
      for (const s of sub) push(s);
    }
  }
  if (current !== undefined) out.push(current);
  return out;
}

function hardCut(part: string, fits: (s: string) => boolean): string[] {
  const out: string[] = [];
  const chars = Array.from(part);
  let start = 0;
  while (start < chars.length) {
    let lo = start + 1;
    let hi = chars.length;
    // Largest end with fits(chars[start..end]); at least one character always goes out.
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(chars.slice(start, mid).join(""))) lo = mid;
      else hi = mid - 1;
    }
    out.push(chars.slice(start, lo).join(""));
    start = lo;
  }
  return out;
}
