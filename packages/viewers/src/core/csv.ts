/**
 * A small RFC 4180 CSV / TSV parser (quoted fields, doubled quotes, CR/LF/CRLF, embedded
 * newlines). Single pass over the string with no per-character allocations, which keeps a
 * 50k-row file well inside the 2 s open budget (P3).
 */

export interface CsvOptions {
  /** Field separator; detected from the first line when omitted. */
  delimiter?: string;
  /** Stop after this many rows (the rest is reported as truncated). */
  maxRows?: number;
}

export interface CsvResult {
  rows: string[][];
  delimiter: string;
  truncated: boolean;
}

export function detectDelimiter(text: string): string {
  const end = text.indexOf("\n");
  const line = end === -1 ? text.slice(0, 4096) : text.slice(0, Math.min(end, 4096));
  let best = ",";
  let bestCount = 0;
  for (const d of [",", "\t", ";", "|"]) {
    let count = 0;
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

export function parseCsv(input: string, opts: CsvOptions = {}): CsvResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const d = delimiter.charCodeAt(0);
  const maxRows = opts.maxRows ?? Number.POSITIVE_INFINITY;
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  let truncated = false;
  while (i < n) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    let field: string;
    if (text.charCodeAt(i) === 34 /* " */) {
      let out = "";
      let start = ++i;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) {
          out += text.slice(start);
          i = n;
          break;
        }
        if (text.charCodeAt(q + 1) === 34) {
          out += `${text.slice(start, q)}"`;
          i = q + 2;
          start = i;
          continue;
        }
        out += text.slice(start, q);
        i = q + 1;
        break;
      }
      field = out;
      // Skip anything between the closing quote and the next separator (lenient).
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === d || c === 10 || c === 13) break;
        i++;
      }
    } else {
      const start = i;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === d || c === 10 || c === 13) break;
        i++;
      }
      field = text.slice(start, i);
    }
    row.push(field);
    const c = text.charCodeAt(i);
    if (c === d) {
      i++;
      if (i === n) row.push("");
    } else {
      if (c === 13 && text.charCodeAt(i + 1) === 10) i += 2;
      else if (i < n) i++;
      rows.push(row);
      row = [];
    }
  }
  if (row.length > 0) rows.push(row);
  return { rows, delimiter, truncated };
}
