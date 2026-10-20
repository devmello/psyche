import type { LibraryItem } from "@psyche/protocol";
import {
  fileIcon,
  type GatewayCall,
  libraryTarget,
  readFileBytes,
  type UiSlots,
  useCall,
} from "@psyche/ui";
import { type ReactElement, useEffect, useState } from "react";
import type { ChatSlotContext } from "../shell/ShellApp.tsx";

/**
 * Chat attachments (feature P4; UI design §3.2, §3.12): a file block's Open shows the Library
 * item in the Files pane with the viewers, and image attachments get a thumbnail. Quarantined
 * downloads never get one: nothing parses them until the owner opens them (§3.12).
 */

/** Thumbnails stop here; larger images show the icon. */
export const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;

export function thumbnailable(item: LibraryItem): boolean {
  return (
    item.quarantined !== true && item.mime.startsWith("image/") && item.size <= THUMBNAIL_MAX_BYTES
  );
}

/** A 40 px thumbnail of an image attachment, read through `files.read`. */
export function AttachmentThumbnail({ item }: { item: LibraryItem }): ReactElement {
  const call = useCall() as GatewayCall;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let made: string | null = null;
    readFileBytes(
      call,
      { libraryPath: item.path },
      {
        signal: abort.signal,
        maxBytes: THUMBNAIL_MAX_BYTES,
      },
    ).then(
      (r) => {
        if (abort.signal.aborted) return;
        made = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: item.mime }));
        setUrl(made);
      },
      () => undefined,
    );
    return () => {
      abort.abort();
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [call, item.path, item.mime]);
  if (url !== null) {
    return <img src={url} alt="" className="size-10 rounded-md object-cover" />;
  }
  const Icon = fileIcon(item.name);
  return <Icon className="size-5 text-gray-9" aria-hidden="true" />;
}

/** The kit's file slots for a chat: Open in the Files pane, image thumbnails. */
export function chatFileSlots(openPane: ChatSlotContext["openPane"]): UiSlots {
  return {
    openLibraryItem: (item) => openPane("files", libraryTarget(item)),
    renderPreview: ({ item }) =>
      item !== undefined && thumbnailable(item) ? <AttachmentThumbnail item={item} /> : null,
  };
}
