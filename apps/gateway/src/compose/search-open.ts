import {
  PsycheError,
  type SearchDocument,
  type SearchOpenTarget,
  type SearchSourceId,
} from "@psyche/protocol";
import {
  OWNER_ONLY_SOURCES,
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

/**
 * True when the agent may not be given this search result, not even its title: an id of an
 * owner-only source (Messages, Contacts, Memory), or of a source the owner kept from the agent.
 */
export function agentBlockedHit(indexer: SourceIndexer | undefined, id: string): boolean {
  const prefix = id.slice(0, Math.max(0, id.indexOf(":")));
  if ((OWNER_ONLY_SOURCES as readonly string[]).includes(prefix)) return true;
  return (
    indexer !== undefined &&
    indexer.document(id, "owner") !== undefined &&
    indexer.document(id, "agent") === undefined
  );
}

function needDocument(deps: SearchOpenDeps, call: Call, id: string): SourceDocument {
  if (call.identity.role !== "client")
    throw new PsycheError("forbidden", "source passages are for the owner's own screens");
  const doc = deps.indexer()?.document(id, "owner");
  // Messages, Contacts and Memory are the owner's alone: only the desktop app itself reads them
  // here, so a paired phone or remote device cannot walk guessable ids (`messages:<rowid>`).
  if (
    doc !== undefined &&
    call.identity.desktopShell !== true &&
    (OWNER_ONLY_SOURCES as readonly string[]).includes(doc.source)
  )
    throw new PsycheError(
      "forbidden",
      "this source is readable from the Psyche app on this Mac only",
    );
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

/** The sources a conversation gist is written from; its source chip never points anywhere else. */
export const GIST_SOURCES: readonly string[] = ["mail", "messages", "calendar"];
/** The sources a catch-up line's chips may point at: the gist ones, and a fact's note or file. */
export const CATCHUP_SOURCES: readonly string[] = [...GIST_SOURCES, "notes", "files"];

/**
 * True when this connection may open `id` in the source viewer, for a gist's source chip. The same
 * rules as `search.document` (a client, not a helper; Messages only from the desktop app on this
 * Mac; the passage must exist and its source must be on), checked again on every read, and only
 * for the sources a gist comes from. Never throws.
 */
export function canOpenGistSource(
  deps: Pick<SearchOpenDeps, "indexer">,
  call: Call,
  id: string,
  kinds: readonly string[] = GIST_SOURCES,
): boolean {
  try {
    const doc = needDocument({ ...deps, folders: () => [] }, call, id);
    return kinds.includes(doc.source);
  } catch {
    return false;
  }
}
