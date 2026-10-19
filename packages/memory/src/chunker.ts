import { createHash } from "node:crypto";

/**
 * Deterministic line-based chunker (architecture §4.8: 400-token chunks, 80 overlap). Chunks
 * keep whole lines so every chunk has an exact source line range; a line longer than a chunk
 * is split by characters and its pieces share the line number. Token counts are estimated
 * (about four characters per token, the usual rule for English with BPE tokenizers): the same
 * input always gives the same chunks, whatever embedder is configured.
 */

export const CHUNK_TOKENS = 400;
export const OVERLAP_TOKENS = 80;
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : Math.ceil(trimmed.length / CHARS_PER_TOKEN);
}

export interface TextChunk {
  /** 1-based, inclusive. */
  lineStart: number;
  lineEnd: number;
  text: string;
  tokenCount: number;
}

export interface ChunkOptions {
  maxTokens?: number;
  overlapTokens?: number;
  /** Line number of the first line of `text` (default 1). */
  firstLine?: number;
}

interface Line {
  no: number;
  text: string;
  /** Fractional token cost of the line plus its newline. */
  tokens: number;
}

export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxTokens = options.maxTokens ?? CHUNK_TOKENS;
  const overlap = Math.min(options.overlapTokens ?? OVERLAP_TOKENS, maxTokens - 1);
  const first = options.firstLine ?? 1;
  // Budget in characters, counting the newline that joins each line to the next.
  const maxChars = maxTokens * CHARS_PER_TOKEN - 1;
  const cost = (line: string) => (line.length + 1) / CHARS_PER_TOKEN;

  // Split over-long lines into pieces that fit in one chunk.
  const lines: Line[] = [];
  text.split("\n").forEach((raw, i) => {
    const no = first + i;
    if (raw.length <= maxChars) {
      lines.push({ no, text: raw, tokens: cost(raw) });
      return;
    }
    for (let at = 0; at < raw.length; at += maxChars) {
      const piece = raw.slice(at, at + maxChars);
      lines.push({ no, text: piece, tokens: cost(piece) });
    }
  });

  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let tokens = 0;
    while (end < lines.length) {
      const t = (lines[end] as Line).tokens;
      if (tokens + t > maxTokens && end > start) break;
      tokens += t;
      end++;
    }
    const slice = lines.slice(start, end);
    const body = slice.map((l) => l.text).join("\n");
    if (body.trim().length > 0) {
      chunks.push({
        lineStart: (slice[0] as Line).no,
        lineEnd: (slice[slice.length - 1] as Line).no,
        text: body.trim(),
        tokenCount: estimateTokens(body),
      });
    }
    if (end >= lines.length) break;
    // Step back over trailing lines worth at most `overlap` tokens, always moving forward.
    let next = end;
    let back = 0;
    while (next - 1 > start && back + (lines[next - 1] as Line).tokens <= overlap) {
      back += (lines[next - 1] as Line).tokens;
      next--;
    }
    start = next;
  }
  return chunks;
}

/**
 * Stable chunk id from its source, first line and text: an unchanged chunk keeps its id (and so
 * its embedding and claim link) across reindexes.
 */
export function chunkId(source: string, lineStart: number, text: string): string {
  const h = createHash("sha256").update(`${source}\n${lineStart}\n${text}`).digest("hex");
  return `chk_${h.slice(0, 26)}`;
}

/**
 * Replaces HTML comments (template guidance for the owner) with blank lines, keeping line
 * numbers, so guidance text is neither indexed nor injected.
 */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (c) => "\n".repeat(c.split("\n").length - 1));
}
