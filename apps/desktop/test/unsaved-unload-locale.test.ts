import { describe, expect, it, vi } from "vitest";
import { CATALOGUES } from "../../../packages/ui/src/i18n/messages/locales/index.ts";

// No i18n mock here: the dialog's words come from the real catalogue, loaded for one language.
vi.mock("electron", () => ({ dialog: { showMessageBoxSync: vi.fn() } }));
const { confirmQuitWithUnsaved, loadUnloadStrings, reportFilesDirty, resetUnsavedFilesForTests } =
  await import("../src/main/unsaved-unload.ts");

const page = () => ({ id: 7, on: vi.fn(), once: vi.fn() }) as never;

describe("the unsaved-edits dialog in the system language (D1)", () => {
  it("shows the German strings for a German system, loading only that catalogue", async () => {
    loadUnloadStrings(() => "de-DE");
    // The dynamic import of i18n-core and of the German chunk settle on later ticks.
    await vi.waitFor(() => {
      resetUnsavedFilesForTests();
      reportFilesDirty(page(), true);
      const ask = vi.fn((_o: Electron.MessageBoxSyncOptions) => 0);
      confirmQuitWithUnsaved(ask);
      const options = ask.mock.calls[0]?.[0] as Electron.MessageBoxSyncOptions | undefined;
      expect(options?.message).toBe(CATALOGUES.de["screens.files.discardAsk"]);
      expect(options?.buttons).toEqual([
        CATALOGUES.de["screens.files.discard"],
        CATALOGUES.de["screens.files.keepEditing"],
      ]);
    });
  });
});
