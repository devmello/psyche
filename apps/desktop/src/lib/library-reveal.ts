import { join } from "node:path";
import { IPC, IpcPayloadError, rec, str } from "./ipc.ts";
import { grantedFilePath, type SourceOpenFs } from "./source-open.ts";

/**
 * Library → "Reveal in Finder" (desktop, this Mac's Gateway only). The renderer sends a Library
 * item id and nothing else. Main asks the Gateway for that item (`library.get`), joins its
 * Library-relative `path` onto the Library folder, and reveals the file only when its real path
 * (symlinks followed) is a regular file inside that folder. `shell.showItemInFolder` never runs
 * the file. Any other answer reveals nothing and the renderer is told so.
 */

const MAX_ITEM_ID = 200;

/** The renderer's request: one Library item id. */
export function checkLibraryReveal(v: unknown): { itemId: string } {
  const itemId = str(IPC.libraryReveal, rec(IPC.libraryReveal, v).itemId, "itemId", MAX_ITEM_ID);
  if (!/^[A-Za-z0-9_.:-]+$/.test(itemId))
    throw new IpcPayloadError(IPC.libraryReveal, "itemId is not a Library item id");
  return { itemId };
}

export interface LibraryRevealDeps {
  /** `library.get` through main's own Gateway connection. */
  getItem: (itemId: string) => Promise<unknown>;
  /** `$PSYCHE_HOME/library` on this Mac. */
  libraryRoot: string;
  showItemInFolder: (path: string) => void;
  fs?: SourceOpenFs;
}

/** "file" when the item's file was revealed; "none" when it is missing or outside the Library. */
export async function revealLibraryItem(
  itemId: string,
  deps: LibraryRevealDeps,
): Promise<"file" | "none"> {
  const item = rec("library.get", rec("library.get", await deps.getItem(itemId)).item);
  if (typeof item.path !== "string" || item.path.length === 0) return "none";
  const path = grantedFilePath(join(deps.libraryRoot, item.path), [deps.libraryRoot], deps.fs);
  if (path === undefined) return "none";
  deps.showItemInFolder(path);
  return "file";
}
