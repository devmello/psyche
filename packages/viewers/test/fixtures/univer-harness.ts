/** Browser harness for the Chrome test: mounts the real Univer runtime on a snapshot. */
import type { IWorkbookData } from "@univerjs/core";
import { loadUniverRuntime } from "../../src/react/univer.ts";

declare global {
  interface Window {
    harness: {
      mount(data: IWorkbookData): Promise<void>;
      snapshot(): IWorkbookData | undefined;
      changes: number;
      dispose(): void;
    };
  }
}

let session:
  | Awaited<ReturnType<Awaited<ReturnType<typeof loadUniverRuntime>>["mount"]>>
  | undefined;
window.harness = {
  changes: 0,
  async mount(data) {
    const runtime = await loadUniverRuntime();
    session = runtime.mount(document.getElementById("app") as HTMLElement, data);
    session.onChange(() => {
      window.harness.changes++;
    });
  },
  snapshot: () => session?.snapshot(),
  dispose: () => session?.dispose(),
};
