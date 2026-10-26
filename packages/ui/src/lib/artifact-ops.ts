import type { ArtifactCell, ArtifactOp, ArtifactTable, ArtifactTableView } from "@psyche/protocol";

/**
 * Client side of the artifact op format (docs/design/chat-experience-2026.md §4.3): turning a
 * canvas edit into the smallest op the Gateway accepts, so a user edit costs the model a short
 * patch on its next turn instead of the whole document. The Gateway stays the authority: it
 * re-applies and versions every op.
 */

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (++n > 1) return n;
  }
  return n;
}

/**
 * One `replace` op that turns `before` into `after`: the changed middle, widened on both sides
 * until its `old` text occurs exactly once. Falls back to `rewrite` when the change is most of
 * the document or no unique anchor exists. Empty when nothing changed.
 */
export function diffToOps(before: string, after: string): ArtifactOp[] {
  if (before === after) return [];
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  if (endB - start > before.length * 0.6) return [{ op: "rewrite", content: after }];
  let s = start;
  let eB = endB;
  let eA = endA;
  // Widen to whole words first, then until the old text is unique.
  for (let pad = 0; pad < 4096; pad += pad < 16 ? 4 : 32) {
    s = Math.max(0, start - pad);
    eB = Math.min(before.length, endB + pad);
    eA = endA + (eB - endB);
    const old = before.slice(s, eB);
    if (old !== "" && count(before, old) === 1)
      return [{ op: "replace", old, new: after.slice(s, eA) }];
    if (s === 0 && eB === before.length) break;
  }
  return [{ op: "rewrite", content: after }];
}

/** Column letters for a zero-based index (0 → A, 26 → AA). */
export function columnName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** The `set` op for one cell (row is zero-based over the data rows). */
export const setCellOp = (row: number, col: number, value: ArtifactCell): ArtifactOp => ({
  op: "set",
  cell: `${columnName(col)}${row + 1}`,
  value,
});

/** A typed cell from what the user typed: numbers stay numbers, empty is null. */
export function cellFromInput(text: string): ArtifactCell {
  const t = text.trim();
  if (t === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return text;
}

/** Rows in display order after the table view (sort, filter); each keeps its source index. */
export function viewRows(
  table: ArtifactTable,
  view: ArtifactTableView | null | undefined,
): Array<{ index: number; cells: ArtifactCell[] }> {
  let rows = table.rows.map((cells, index) => ({ index, cells }));
  const filter = view?.filter;
  if (filter) {
    const c = table.columns.indexOf(filter.column);
    const needle = filter.contains.toLowerCase();
    if (c >= 0)
      rows = rows.filter((r) =>
        String(r.cells[c] ?? "")
          .toLowerCase()
          .includes(needle),
      );
  }
  const sort = view?.sort;
  if (sort) {
    const c = table.columns.indexOf(sort.column);
    if (c >= 0) {
      const dir = sort.dir === "desc" ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const x = a.cells[c] ?? null;
        const y = b.cells[c] ?? null;
        if (x === y) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return (
          (typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x).localeCompare(String(y))) * dir
        );
      });
    }
  }
  return rows;
}

/** CSV for Copy and Download. */
export function tableToCsv(table: ArtifactTable): string {
  const esc = (v: ArtifactCell | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [table.columns, ...table.rows].map((r) => r.map(esc).join(",")).join("\n");
}

/**
 * A small local applier for the mock Gateway and stories: text replace/insert/rewrite, table
 * set/addRows/view. Throws on what the real Gateway would refuse. The Gateway's engine
 * (`apps/gateway/src/artifacts/ops.ts`) is the authority.
 */
export function applyOpsLocal(
  type: string,
  content: string,
  view: ArtifactTableView | null,
  ops: readonly ArtifactOp[],
): { content: string; view: ArtifactTableView | null } {
  if (type === "table" || type === "sheet") {
    const t = JSON.parse(content) as ArtifactTable;
    let v = view;
    for (const op of ops) {
      if (op.op === "set") {
        const m = /^([A-Z]+)(\d+)$/.exec(op.cell);
        if (m === null) throw new Error(`bad cell ${op.cell}`);
        let col = 0;
        for (const ch of m[1] as string) col = col * 26 + ch.charCodeAt(0) - 64;
        const row = t.rows[Number(m[2]) - 1];
        if (row === undefined || col > t.columns.length) throw new Error(`no cell ${op.cell}`);
        row[col - 1] = op.value;
      } else if (op.op === "addRows") t.rows.splice(op.at ?? t.rows.length, 0, ...op.rows);
      else if (op.op === "view") v = { ...(v ?? {}), ...op.view };
      else if (op.op === "rewrite") return { content: op.content, view: null };
      else throw new Error(`${op.op} is not supported here`);
    }
    return { content: JSON.stringify(t), view: v };
  }
  if (type === "chart") {
    let c = JSON.parse(content) as Record<string, unknown>;
    for (const op of ops) {
      if (op.op === "patch") c = { ...c, ...op.patch };
      else if (op.op === "rewrite") c = JSON.parse(op.content) as Record<string, unknown>;
      else throw new Error(`${op.op} does not apply to a chart`);
    }
    return { content: JSON.stringify(c), view: null };
  }
  let text = content;
  for (const op of ops) {
    if (op.op === "rewrite") text = op.content;
    else if (op.op === "replace" || op.op === "insert") {
      const anchor = op.op === "replace" ? op.old : op.after;
      if (op.op === "insert" && anchor === "") {
        text = op.text + text;
        continue;
      }
      if (count(text, anchor) !== 1) throw new Error("anchor must match exactly once");
      const at = text.indexOf(anchor);
      text =
        op.op === "replace"
          ? text.slice(0, at) + op.new + text.slice(at + anchor.length)
          : text.slice(0, at + anchor.length) + op.text + text.slice(at + anchor.length);
    } else throw new Error(`${op.op} applies to tables`);
  }
  return { content: text, view: null };
}
