import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  type AttachmentChip,
  type AttachSupport,
  acceptFor,
  admitFiles,
  attachmentIds,
  canAttach,
  chipsReducer,
  type Refused,
  uploading,
} from "./attachments.ts";

/** Everything the composer needs to show and manage attachments. */
export interface ComposerAttach {
  chips: readonly AttachmentChip[];
  /** The file picker's `accept`. */
  accept: string;
  /** Files refused by the last add, until the next add or dismissal. */
  refused: readonly Refused[];
  /** Files from the picker, a drop or a paste. */
  onFiles: (files: readonly File[]) => void;
  onRemove: (key: string) => void;
  onDismissRefused: () => void;
  /** Whether the model takes images (the drop hint and refusals read it). */
  images: boolean;
}

export interface UseAttachments {
  /** Absent when the model takes no files: the composer then shows no + button. */
  attach: ComposerAttach | undefined;
  /** The finished uploads' Library ids, for `chat.send`. */
  ids: string[];
  /** Sending waits while any file is still uploading. */
  uploading: boolean;
  /** After a send: forget the chips. */
  clear: () => void;
}

let nextKey = 0;

/**
 * A thread's composer attachments: each file becomes a chip at once, uploads in the background
 * (`upload` returns the Library item id) and can be removed. Chips of files the model cannot take
 * (an image, for a model without vision) are never created; the refusal says why instead.
 */
export function useAttachments(
  support: AttachSupport,
  upload: (file: File, signal: AbortSignal) => Promise<string>,
): UseAttachments {
  const [chips, dispatch] = useReducer(chipsReducer, [] as readonly AttachmentChip[]);
  const [refused, setRefused] = useState<readonly Refused[]>([]);
  const aborts = useRef(new Map<string, AbortController>());
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  const supportRef = useRef(support);
  supportRef.current = support;

  const onFiles = useCallback((files: readonly File[]) => {
    const { accepted, refused: no } = admitFiles(
      files,
      supportRef.current,
      chipsRef.current.length,
    );
    setRefused(no);
    if (accepted.length === 0) return;
    const added = accepted.map(({ file, kind }) => ({
      file,
      chip: {
        key: `attach-${++nextKey}`,
        name: file.name,
        kind,
        status: "uploading" as const,
      },
    }));
    dispatch({ type: "add", chips: added.map((a) => a.chip) });
    for (const { file, chip } of added) {
      const abort = new AbortController();
      aborts.current.set(chip.key, abort);
      uploadRef.current(file, abort.signal).then(
        (itemId) => {
          aborts.current.delete(chip.key);
          if (!abort.signal.aborted) dispatch({ type: "uploaded", key: chip.key, itemId });
        },
        () => {
          aborts.current.delete(chip.key);
          if (!abort.signal.aborted) dispatch({ type: "failed", key: chip.key });
        },
      );
    }
  }, []);

  const onRemove = useCallback((key: string) => {
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    dispatch({ type: "remove", key });
  }, []);

  const clear = useCallback(() => {
    // The uploads that finished stay in the Library: they were sent.
    aborts.current.clear();
    dispatch({ type: "clear" });
  }, []);

  useEffect(
    () => () => {
      for (const a of aborts.current.values()) a.abort();
    },
    [],
  );

  const onDismissRefused = useCallback(() => setRefused([]), []);
  const show = canAttach(support);
  const attach = useMemo<ComposerAttach | undefined>(
    () =>
      show
        ? {
            chips,
            accept: acceptFor(support),
            refused,
            onFiles,
            onRemove,
            onDismissRefused,
            images: support.images,
          }
        : undefined,
    [show, chips, support, refused, onFiles, onRemove, onDismissRefused],
  );
  return {
    attach,
    ids: attachmentIds(chips),
    uploading: uploading(chips),
    clear,
  };
}
