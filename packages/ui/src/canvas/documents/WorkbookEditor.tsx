import {
  type ArtifactWorkbook,
  type ArtifactWorkbookCell,
  type Computed,
  colToIndex,
  computeWorkbook,
  indexToCol,
  parseWorkbook,
} from "@psyche/protocol";
import { Plus } from "lucide-react";
import { type ReactElement, useMemo, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import type { DocumentEditorProps } from "./DeckEditor.tsx";

const MIN_ROWS = 20;
const MIN_COLS = 8;

/** What the owner typed, as a cell: `=…` is a formula, numbers and TRUE / FALSE are typed, empty clears. */
export function cellFromText(text: string): ArtifactWorkbookCell {
  const s = text.trim();
  if (s === "") return null;
  if (s.startsWith("=") && s.length > 1) return { f: s.slice(1) };
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === "true";
  return text;
}

const rawText = (c: ArtifactWorkbookCell | undefined): string =>
  c === undefined || c === null ? "" : typeof c === "object" ? `=${c.f}` : String(c);
const shown = (v: Computed | undefined): string =>
  v === undefined || v === null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);

/**
 * The workbook editor: sheet tabs, a grid of computed values and a formula bar for the selected
 * cell. Each commit is one `setCells` op, so the agent's edits to other cells survive. A host
 * that has Univer can take the body over through the `renderArtifact` slot.
 */
export default function WorkbookEditor({
  title,
  content,
  editable,
  onCommit,
}: DocumentEditorProps): ReactElement {
  const wb = useMemo((): ArtifactWorkbook | null => {
    try {
      return parseWorkbook(content);
    } catch {
      return null;
    }
  }, [content]);
  const values = useMemo(() => (wb === null ? {} : computeWorkbook(wb)), [wb]);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [sel, setSel] = useState("A1");
  const [draft, setDraft] = useState<string | null>(null);
  if (wb === null)
    return (
      <p className="text-callout text-label-secondary" role="status">
        {t("canvas.invalid", { kind: "workbook" })}
      </p>
    );
  const sheet =
    wb.sheets.find((s) => s.name === sheetName) ??
    (wb.sheets[0] as ArtifactWorkbook["sheets"][number]);
  const computed = values[sheet.name] ?? {};
  let rows = MIN_ROWS;
  let cols = MIN_COLS;
  for (const ref of Object.keys(sheet.cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref) as RegExpExecArray;
    rows = Math.max(rows, Number(m[2]) + 1);
    cols = Math.max(cols, colToIndex(m[1] as string) + 2);
  }
  const commit = (ref: string, text: string) => {
    setDraft(null);
    if (text === rawText(sheet.cells[ref])) return;
    void onCommit([{ op: "setCells", sheet: sheet.name, cells: { [ref]: cellFromText(text) } }]);
  };
  const barValue = draft ?? rawText(sheet.cells[sel]);

  return (
    <section aria-label={t("book.label", { title })} className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-center text-callout font-semibold tabular-nums">
          {sel}
        </span>
        <Input
          aria-label={t("book.formulaBar", { ref: sel })}
          className="font-mono text-mono"
          value={barValue}
          readOnly={!editable}
          placeholder={t("book.hint")}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => draft !== null && commit(sel, draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft !== null) commit(sel, draft);
            if (e.key === "Escape") setDraft(null);
          }}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-sm border border-separator">
        <table className="border-collapse text-body tabular-nums" aria-label={sheet.name}>
          <thead>
            <tr>
              <th className="sticky start-0 top-0 z-10 w-10 border-b border-e border-separator bg-background" />
              {Array.from({ length: cols }, (_, c) => (
                <th
                  key={indexToCol(c)}
                  scope="col"
                  className="sticky top-0 min-w-24 border-b border-separator bg-background px-2 py-1 text-callout font-semibold text-label-secondary"
                >
                  {indexToCol(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }, (_, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
              <tr key={r}>
                <th
                  scope="row"
                  className="sticky start-0 border-e border-separator bg-background px-2 text-callout font-normal text-label-secondary"
                >
                  {r + 1}
                </th>
                {Array.from({ length: cols }, (_, c) => {
                  const ref = `${indexToCol(c)}${r + 1}`;
                  const v = computed[ref];
                  return (
                    <td key={ref} className="h-7 max-w-64 border-b border-e border-separator p-0">
                      <button
                        type="button"
                        aria-label={t("book.cell", { ref })}
                        aria-pressed={ref === sel}
                        onClick={() => {
                          if (draft !== null) commit(sel, draft);
                          setSel(ref);
                        }}
                        className={cn(
                          "block h-7 w-full cursor-cell truncate px-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-accent-8 focus-visible:ring-inset",
                          typeof v === "number" ? "text-end" : "",
                          typeof v === "string" && v.startsWith("#") ? "text-danger-text" : "",
                          ref === sel ? "bg-selection ring-2 ring-accent-8 ring-inset" : "",
                        )}
                      >
                        {shown(v)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        role="tablist"
        aria-label={t("book.sheets")}
        className="flex items-center gap-1 overflow-x-auto"
      >
        {wb.sheets.map((s) => (
          <button
            key={s.name}
            type="button"
            role="tab"
            aria-selected={s.name === sheet.name}
            onClick={() => setSheetName(s.name)}
            className={cn(
              "rounded-sm px-3 py-1 text-callout outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              s.name === sheet.name
                ? "bg-selection font-semibold"
                : "text-label-secondary hover:bg-fill-quaternary",
            )}
          >
            {s.name}
          </button>
        ))}
        {editable ? (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("book.addSheet")}
            onClick={() => {
              let n = wb.sheets.length + 1;
              const taken = new Set(wb.sheets.map((s) => s.name.toLowerCase()));
              while (taken.has(t("book.newSheet", { n }).toLowerCase())) n++;
              const name = t("book.newSheet", { n });
              void onCommit([{ op: "addSheet", name }]);
              setSheetName(name);
            }}
          >
            <Plus aria-hidden="true" />
          </Button>
        ) : null}
      </div>
    </section>
  );
}
