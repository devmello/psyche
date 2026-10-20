/**
 * IMAP response tokenizer (RFC 9051 §4): atoms, quoted strings, literals (already read into
 * bytes and spliced in by the client), parenthesized lists, `NIL`, and `BODY[...]` section
 * specifiers kept as one token. Server data is untrusted: the parser never throws on garbage,
 * it returns what it could read.
 */

export type ImapToken = string | null | Uint8Array | ImapToken[];

export const LITERAL_MARK = "\u0000";

export function tokenize(line: string, literals: Uint8Array[]): ImapToken[] {
  let i = 0;
  const n = line.length;
  const readList = (): ImapToken[] => {
    const out: ImapToken[] = [];
    while (i < n) {
      const c = line[i] as string;
      if (c === " ") {
        i += 1;
        continue;
      }
      if (c === ")" || c === "]") {
        i += 1;
        return out;
      }
      if (c === "(") {
        i += 1;
        out.push(readList());
        continue;
      }
      if (c === '"') {
        i += 1;
        let s = "";
        while (i < n && line[i] !== '"') {
          if (line[i] === "\\" && i + 1 < n) i += 1;
          s += line[i];
          i += 1;
        }
        i += 1;
        out.push(s);
        continue;
      }
      if (c === LITERAL_MARK) {
        const end = line.indexOf(LITERAL_MARK, i + 1);
        const idx = Number(line.slice(i + 1, end));
        i = end + 1;
        out.push(literals[idx] ?? new Uint8Array());
        continue;
      }
      // Atom; `BODY[...]` / `BINARY[...]` keep their bracketed section (which may hold spaces).
      let s = "";
      while (i < n && line[i] !== " " && line[i] !== ")" && line[i] !== "(") {
        if (line[i] === "[") {
          let depth = 0;
          while (i < n) {
            const ch = line[i] as string;
            s += ch;
            i += 1;
            if (ch === "[") depth += 1;
            if (ch === "]") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          // Optional partial `<origin>`.
          if (line[i] === "<") {
            while (i < n && line[i] !== ">") {
              s += line[i];
              i += 1;
            }
            s += ">";
            i += 1;
          }
          continue;
        }
        if (line[i] === "]") break;
        s += line[i];
        i += 1;
      }
      if (s === "") {
        i += 1;
        continue;
      }
      out.push(s.toUpperCase() === "NIL" ? null : s);
    }
    return out;
  };
  return readList();
}

export function asString(t: ImapToken | undefined): string {
  if (typeof t === "string") return t;
  if (t instanceof Uint8Array) return Buffer.from(t).toString("latin1");
  return "";
}

export function asBytes(t: ImapToken | undefined): Uint8Array {
  if (t instanceof Uint8Array) return t;
  if (typeof t === "string") return Buffer.from(t, "latin1");
  return new Uint8Array();
}

/** `(UID 1 FLAGS (\Seen) ...)` → map keyed by upper-cased item name. */
export function fetchItems(list: ImapToken[]): Map<string, ImapToken> {
  const out = new Map<string, ImapToken>();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = asString(list[i])
      .toUpperCase()
      .replace(/^BODY\.PEEK\[/, "BODY[");
    out.set(key, list[i + 1] as ImapToken);
  }
  return out;
}

/** `"19-Oct-2026 08:00:00 -0700"` → ISO 8601, or the input when unparseable. */
export function internalDateToIso(value: string): string {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\s*$/.exec(
    value,
  );
  if (m === null) return value;
  const months = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const mon = months.indexOf((m[2] as string).toLowerCase());
  if (mon < 0) return value;
  const tz = m[7] as string;
  const iso = `${m[3]}-${String(mon + 1).padStart(2, "0")}-${(m[1] as string).padStart(2, "0")}T${m[4]}:${m[5]}:${m[6]}${tz.slice(0, 3)}:${tz.slice(3)}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/** ISO date → IMAP date (`19-Oct-2026`). */
export function isoToImapDate(value: string): string | undefined {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${d.getUTCDate()}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
}
