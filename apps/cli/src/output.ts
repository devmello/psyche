/** Human output helpers. JSON output is always `JSON.stringify(result, null, 2)`. */

export type Row = Record<string, unknown>;

function cell(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return value.map(cell).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Left-aligned text table; `columns` maps a header to a row key. */
export function table(
  rows: readonly Row[],
  columns: Record<string, string>,
  empty = "(none)",
): string {
  if (rows.length === 0) return empty;
  const headers = Object.keys(columns);
  const body = rows.map((r) => headers.map((h) => cell(r[columns[h] ?? h])));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((line) => (line[i] ?? "").length)),
  );
  const fmt = (line: string[]) =>
    line
      .map((c, i) => (i === line.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return [fmt(headers.map((h) => h.toUpperCase())), ...body.map(fmt)].join("\n");
}

export function kv(pairs: Record<string, unknown>): string {
  const width = Math.max(...Object.keys(pairs).map((k) => k.length));
  return Object.entries(pairs)
    .map(([k, v]) => `${`${k}:`.padEnd(width + 1)} ${cell(v)}`)
    .join("\n");
}

const MARK = { ok: "ok  ", warn: "warn", fail: "FAIL", info: "info", skip: "skip" } as const;

export function statusLine(status: keyof typeof MARK, text: string): string {
  return `[${MARK[status]}] ${text}`;
}

export function bytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
