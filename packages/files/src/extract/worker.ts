import { parentPort } from "node:worker_threads";
import { type ExtractRequest, extractInProcess } from "./document.ts";
import { DocumentError } from "./pager.ts";

// Worker entry for `extractDocument`: one request, one reply, then the parent terminates us.
parentPort?.once("message", (req: ExtractRequest) => {
  extractInProcess(req).then(
    (page) => parentPort?.postMessage({ ok: true, page }),
    (err: unknown) =>
      parentPort?.postMessage({
        ok: false,
        // Library messages can quote document bytes; only our own messages pass through.
        message: err instanceof DocumentError ? err.message : "could not extract text",
      }),
  );
});
