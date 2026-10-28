import { createHash } from "node:crypto";
import type { TurnToolContext } from "@psyche/agent-core";
import type { DocumentBridge } from "@psyche/files";
import { PsycheError } from "@psyche/protocol";
import { exportArtifact, extOf, IMPORT_EXTENSIONS, importDocument } from "./documents.ts";
import type { ArtifactStore } from "./store.ts";

/** The store is made by the artifacts part, after the file tools register: they reach it through this. */
export interface DocumentsHandle {
  store?: ArtifactStore;
}

const PREVIEW = { doc: "markdown", workbook: "sheet", slides: "markdown" } as const;

/**
 * Connects the file tools' `open_document` / `write_document` to the artifact store: a synchronous
 * fingerprint for the approval card's binding, export to the extension of the target path, and
 * import into a new artifact (marked untrusted: it came from a file).
 */
export function documentBridge(handle: DocumentsHandle): DocumentBridge {
  const store = (): ArtifactStore => {
    if (handle.store === undefined) throw new PsycheError("internal", "artifacts are not ready");
    return handle.store;
  };
  return {
    fingerprint(artifactId) {
      const a = store().get(artifactId);
      return {
        title: a.artifact.title,
        type: a.artifact.type,
        version: a.artifact.version,
        hash: createHash("sha256").update(a.content).digest("hex"),
      };
    },
    async exportTo(artifactId, path) {
      const a = store().get(artifactId);
      return (await exportArtifact(a.artifact.type, a.artifact.title, a.content, extOf(path)))
        .bytes;
    },
    async importFrom(path, bytes, ctx, options) {
      if (IMPORT_EXTENSIONS[extOf(path)] === undefined)
        throw new PsycheError("invalid_params", `cannot open .${extOf(path)} as a document`);
      const name = path.split("/").pop() ?? path;
      const imported = await importDocument(name, bytes);
      const w = await store().create(
        {
          type: imported.type,
          title: options.title ?? imported.title,
          content: imported.content,
          threadId: ctx.threadId,
          untrusted: true,
        },
        { author: "agent", runId: ctx.runId, toolCallId: ctx.callId },
      );
      (ctx as Partial<TurnToolContext>).turn?.emitBlock({
        type: "artifact",
        artifactId: w.artifact.id,
        preview: PREVIEW[imported.type],
      });
      return { ...w.ref, source: path, notes: imported.notes };
    },
  };
}
