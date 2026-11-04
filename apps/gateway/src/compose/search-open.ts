import {
  PsycheError,
  type SearchDocument,
  type SearchOpenTarget,
  type SearchSourceId,
} from "@psyche/protocol";
import {
  parseMessageId,
  resolveGrantedFile,
  type SourceDocument,
  type SourceIndexer,
} from "@psyche/search";
import type { Call, HandlerDef } from "../context.ts";

/**
 * `search.document` and `search.openSource` (docs/roadmap/future-features.md §1, phase 2): the
 * indexed passage behind a citation chip or a search result, and where the desktop may open it.
 *
 * Both are the owner's: a paired client reads Messages, Contacts and Memory passages here even
 * though the agent may not search them (the agent has no route to these methods; its own
 * `search_everything` applies `audience: "agent"`). A Mac helper (`node`) is refused. Targets are
 * resolved here from the indexed document, never from caller text, and a file's only when it sits
 * inside a folder that is granted now.
 */

/** Most text sent to the viewer; the indexed body is clipped (and the reply says so). */
export const VIEWER_TEXT_CHARS = 20_000;

export interface SearchOpenDeps {
  indexer: () => SourceIndexer | undefined;
  /** The folders granted now (the Files source's); empty when the host has none. */
  folders: () => readonly { path: string }[];
  /** Why Memory's passages may not be read now (memory encrypted while search is not), or undefined. */
  memoryBlocked?: () => string | undefined;
}

function needDocument(deps: SearchOpenDeps, call: Call, id: string): SourceDocument {
  if (call.identity.role !== "client")
    throw new PsycheError("forbidden", "source passages are for the owner's own screens");
  const doc = deps.indexer()?.document(id, "owner");
  const blocked = doc?.source === "memory" && deps.memoryBlocked?.() !== undefined;
  if (doc === undefined || blocked)
    throw new PsycheError("not_found", "no such source passage (it may have been removed)");
  return doc;
}

/** The file of a document, resolved now against the granted folders; undefined when it may not be shown. */
function grantedFile(deps: SearchOpenDeps, doc: SourceDocument) {
  if (doc.source !== "files" || doc.path === null) return undefined;
  return resolveGrantedFile(
    doc.path,
    deps.folders().map((f) => f.path),
  );
}

/** What outside opener this document has, if any. */
export function openerOf(deps: SearchOpenDeps, doc: SourceDocument): "mail" | "file" | null {
  if (doc.source === "mail") return parseMessageId(doc.openRef) === undefined ? null : "mail";
  if (doc.source === "files") return grantedFile(deps, doc) === undefined ? null : "file";
  return null;
}

/** The target main may open for `doc`, or null. */
export function openTargetOf(deps: SearchOpenDeps, doc: SourceDocument): SearchOpenTarget | null {
  if (doc.source === "mail") {
    const messageId = parseMessageId(doc.openRef);
    return messageId === undefined ? null : { kind: "mail", messageId };
  }
  const file = grantedFile(deps, doc);
  return file === undefined ? null : { kind: "file", path: file.path, roots: file.roots };
}

export function searchOpenHandlers(deps: SearchOpenDeps): Record<string, HandlerDef> {
  return {
    "search.document": {
      run: (call: Call, params: never): SearchDocument => {
        const doc = needDocument(deps, call, (params as { id: string }).id);
        const truncated = doc.text.length > VIEWER_TEXT_CHARS;
        return {
          id: doc.id,
          source: doc.source as SearchSourceId,
          title: doc.title.slice(0, 2000),
          text: truncated ? doc.text.slice(0, VIEWER_TEXT_CHARS) : doc.text,
          truncated,
          createdAt: Math.max(0, Math.trunc(doc.createdAt)),
          provenance: doc.provenance,
          open: openerOf(deps, doc),
        };
      },
    },
    "search.openSource": {
      run: (call: Call, params: never) => {
        // Where a Message-ID or a host path goes is for the Psyche app on this Mac only: another
        // paired device is not on the Host, and its paths mean nothing there.
        if (call.identity.desktopShell !== true)
          throw new PsycheError("forbidden", "sources open from the Psyche app on this Mac", {
            details: { reason: "not_desktop" },
          });
        const doc = needDocument(deps, call, (params as { id: string }).id);
        return { target: openTargetOf(deps, doc) };
      },
    },
  };
}
