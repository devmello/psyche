import type { IWorkbookData } from "@univerjs/core";

/**
 * The narrow slice of Univer the sheet editor uses, so the component can be tested with a fake
 * and Univer (≈ 18 MB of ES modules before minification) stays in its own lazily loaded chunk:
 * nothing here is imported until the user presses Edit.
 */
export interface SheetEditorSession {
  /** The current workbook, with formula results recalculated by Univer. */
  snapshot(): IWorkbookData;
  /** Called after every mutation (cell edit, paste, insert row, merge, ...). */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export interface SheetEditorRuntime {
  mount(container: HTMLElement, data: IWorkbookData): SheetEditorSession;
}

/** Univer's `CommandType.MUTATION`: the only kind that changes the document. */
const MUTATION = 2;

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
        if (event.type === MUTATION) for (const l of listeners) l();
      });
      return {
        snapshot: () => workbook.save(),
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
