import type { IWorkbookData } from "@univerjs/core";
import { applyFormulas } from "../core/sheet-edit.ts";

/**
 * The narrow slice of Univer the sheet editor uses, so the component can be tested with a fake
 * and Univer (≈ 18 MB of ES modules before minification) stays in its own lazily loaded chunk:
 * nothing here is imported until the user presses Edit.
 */
export interface SheetEditorSession {
  /**
   * The current workbook, with formula results recalculated by Univer and shared (filled or
   * pasted) formulas resolved per cell.
   */
  snapshot(): IWorkbookData;
  /** Called after every user change (cell edit, paste, insert row, merge, undo, ...). */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export interface SheetEditorRuntime {
  mount(container: HTMLElement, data: IWorkbookData): SheetEditorSession;
}

/** Univer's `CommandType.COMMAND`: what user actions run (mutations follow from them). */
const COMMAND = 0;

/**
 * User commands that change the workbook. Formula recalculation on load runs mutations without a
 * command, and selection, scrolling, zoom and tab switches are view state, so neither marks dirty.
 */
export function isEditCommand(id: string): boolean {
  if (id === "univer.command.undo" || id === "univer.command.redo") return true;
  if (!id.startsWith("sheet.command.")) return false;
  return !/^sheet\.command\.(scroll|move-selection|select|expand-selection|set-selection|set-worksheet-activate|set-zoom|set-scroll|set-activate|set-frozen-cancel-view)/.test(
    id,
  );
}

/**
 * Loads Univer 1.0.3 (Apache-2.0: core, render and formula engines and the sheets UI; no
 * telemetry, and its HTTP service only runs when a plugin asks for a URL, which none here do).
 * Formulas run on the main thread (no `workerURL`), so no worker origin has to be allowed.
 */
export async function loadUniverRuntime(): Promise<SheetEditorRuntime> {
  const [presets, core, locale] = await Promise.all([
    import("@univerjs/presets"),
    import("@univerjs/preset-sheets-core"),
    import("@univerjs/preset-sheets-core/locales/en-US"),
    import("@univerjs/preset-sheets-core/lib/index.css"),
  ]);
  return {
    mount(container, data) {
      const { univer, univerAPI } = presets.createUniver({
        locale: presets.LocaleType.EN_US,
        locales: { [presets.LocaleType.EN_US]: presets.mergeLocales(locale.default) },
        presets: [
          core.UniverSheetsCorePreset({
            container,
            header: true,
            toolbar: true,
            footer: { sheetBar: true, statisticBar: true, menus: false, zoomSlider: true },
          }),
        ],
      });
      const workbook = univerAPI.createWorkbook(data);
      const listeners = new Set<() => void>();
      const sub = univerAPI.addEvent(univerAPI.Event.CommandExecuted, (event) => {
        if (event.type === COMMAND && isEditCommand(event.id)) for (const l of listeners) l();
      });
      return {
        snapshot() {
          const data = workbook.save();
          for (const sheet of workbook.getSheets()) {
            const rows = sheet.getLastRow() + 1;
            const cols = sheet.getLastColumn() + 1;
            if (rows <= 0 || cols <= 0) continue;
            applyFormulas(data, sheet.getSheetId(), sheet.getRange(0, 0, rows, cols).getFormulas());
          }
          return data;
        },
        onChange(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        dispose() {
          listeners.clear();
          sub.dispose();
          univer.dispose();
        },
      };
    },
  };
}
