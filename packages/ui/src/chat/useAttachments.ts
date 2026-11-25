import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  type AttachmentChip,
  type AttachSupport,
  acceptFor,
  admitFiles,
  attachedPaths,
  attachmentIds,
  type ChipAction,
  canAttach,
  chipsReducer,
  classifyFile,
  hasFailed,
  type LibraryAttachItem,
  libraryChips,
  MAX_ATTACHMENTS,
  type NativeAttach,
  nativeRefusal,
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
  /** Tries a failed chip's upload (or read grant) again. */
  onRetry: (key: string) => void;
  onDismissRefused: () => void;
  /** Whether the model takes images (the drop hint and refusals read it). */
  images: boolean;
}

export interface UseAttachments {
  /** Absent when the model takes no files: the composer then shows no + button. */
  attach: ComposerAttach | undefined;
  /** The finished uploads' Library ids, for `chat.send`. */
  ids: string[];
  /** Files from disk (desktop) the message carries, as `chat.send` `attachedFiles`. */
  attachedFiles: { path: string }[];
  /** Sending waits while any file is still uploading. */
  uploading: boolean;
  /** A file failed: sending waits until it is retried or removed (it would be dropped). */
  failed: boolean;
  /** After a send: forget the chips. */
  clear: () => void;
  /** The send was refused (the chat was busy): put the chips back. */
  restore: (chips: readonly AttachmentChip[]) => void;
  /** The chips now, for a send to keep until it is accepted. */
  snapshot: () => readonly AttachmentChip[];
  /** Library items handed to this composer (Send to chat): ready chips, refused ones named. */
  addItems: (items: readonly LibraryAttachItem[]) => void;
}

let nextKey = 0;

/**
 * Chips live outside the component, by scope (the thread id): the chat remounts when the owner
 * switches threads, and the chips, and the uploads still running, must survive that. A scope
 * without a thread id (a bare story) is private to its hook and dropped with it.
 */
interface Scope {
  chips: readonly AttachmentChip[];
  listeners: Set<() => void>;
}
const scopes = new Map<string, Scope>();
const NONE: readonly AttachmentChip[] = [];
/** Running uploads, by chip key: removing a chip aborts its own. */
const aborts = new Map<string, AbortController>();
/** What to run again for a failed chip, by chip key. */
const retries = new Map<string, () => void>();

function scopeOf(id: string): Scope {
  let s = scopes.get(id);
  if (s === undefined) {
    s = { chips: NONE, listeners: new Set() };
    scopes.set(id, s);
  }
  return s;
}

function dispatchTo(id: string, action: ChipAction): void {
  const s = scopeOf(id);
  const next = chipsReducer(s.chips, action);
  if (next === s.chips) return;
  s.chips = next.length === 0 ? NONE : next;
  for (const l of Array.from(s.listeners)) l();
  if (s.chips === NONE && s.listeners.size === 0) scopes.delete(id);
}

function forget(chips: readonly AttachmentChip[]): void {
  for (const c of chips) {
    aborts.get(c.key)?.abort();
    aborts.delete(c.key);
    retries.delete(c.key);
  }
}

/** Test teardown: drops every scope and aborts what is running. */
export function resetAttachmentScopes(): void {
  for (const s of scopes.values()) forget(s.chips);
  scopes.clear();
}

/** How many chips a thread holds right now (drafts survive a thread switch). */
export function attachmentCount(threadId: string): number {
  return scopes.get(threadId)?.chips.length ?? 0;
}

/**
 * A thread's composer attachments: each file becomes a chip at once, uploads in the background
 * (`upload` returns the Library item id) and can be removed. Chips of files the model cannot take
 * (an image, for a model without vision) are never created; the refusal says why instead. With a
 * `threadId` the chips and their uploads outlive the component (a thread switch).
 */
export function useAttachments(
  support: AttachSupport,
  upload: (file: File, signal: AbortSignal) => Promise<string>,
  native?: NativeAttach,
  threadId?: string,
): UseAttachments {
  const own = useRef<string | null>(null);
  if (own.current === null) own.current = `local-${++nextKey}`;
  const scope = threadId ?? own.current;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const chips = useSyncExternalStore(
    useCallback(
      (cb) => {
        const s = scopeOf(scope);
        s.listeners.add(cb);
        return () => {
          s.listeners.delete(cb);
          if (s.chips === NONE && s.listeners.size === 0) scopes.delete(scope);
        };
      },
      [scope],
    ),
    () => scopes.get(scope)?.chips ?? NONE,
  );
  const dispatch = useCallback((a: ChipAction) => dispatchTo(scopeRef.current, a), []);
  const [refused, setRefused] = useState<readonly Refused[]>([]);
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const uploadRef = useRef(upload);
  uploadRef.current = upload;
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const supportRef = useRef(support);
  supportRef.current = support;

  /** Reads the grant for one in-place chip; a failure leaves an error chip with a retry. */
  const grantInPlace = useCallback((id: string, key: string, name: string, path: string) => {
    const run = () => {
      const grant = nativeRef.current?.attach([path]);
      if (grant === undefined) {
        dispatchTo(id, { type: "failed", key });
        return;
      }
      void grant.then(
        (res) => {
          retries.delete(key);
          const ok = res.files[0];
          if (ok !== undefined) {
            dispatchTo(id, { type: "granted", key, path: ok.path });
            return;
          }
          // Refused (a sensitive file, a folder): no chip, and the owner is told why.
          dispatchTo(id, { type: "remove", key });
          const why = nativeRefusal(res.refused[0]?.reason ?? "");
          if (scopeRef.current === id) setRefused((r) => [...r, { name, reason: why }]);
        },
        () => dispatchTo(id, { type: "failed", key }),
      );
    };
    retries.set(key, () => {
      dispatchTo(id, { type: "retry", key });
      run();
    });
    run();
  }, []);

  /** Uploads one file for a chip; a failure leaves an error chip with a retry. */
  const startUpload = useCallback((id: string, key: string, file: File) => {
    const run = () => {
      const abort = new AbortController();
      aborts.set(key, abort);
      uploadRef.current(file, abort.signal).then(
        (itemId) => {
          aborts.delete(key);
          if (abort.signal.aborted) return;
          retries.delete(key);
          dispatchTo(id, { type: "uploaded", key, itemId });
        },
        () => {
          aborts.delete(key);
          if (!abort.signal.aborted) dispatchTo(id, { type: "failed", key });
        },
      );
    };
    retries.set(key, () => {
      dispatchTo(id, { type: "retry", key });
      run();
    });
    run();
  }, []);

  /** Files that have a real path: attached in place, no upload (desktop). */
  const attachInPlace = useCallback(
    (picked: readonly { file: File; path: string }[], have: number): Refused[] => {
      const no: Refused[] = [];
      const added: { key: string; path: string; chip: AttachmentChip }[] = [];
      for (const { file, path } of picked) {
        const kind = classifyFile(file) ?? "document";
        if (kind === "image" && !supportRef.current.images) {
          no.push({ name: file.name, reason: "image" });
        } else if (have + added.length >= MAX_ATTACHMENTS) {
          no.push({ name: file.name, reason: "count" });
        } else {
          const key = `attach-${++nextKey}`;
          added.push({ key, path, chip: { key, name: file.name, kind, status: "uploading" } });
        }
      }
      if (added.length > 0) dispatch({ type: "add", chips: added.map((a) => a.chip) });
      for (const { key, path, chip } of added) {
        grantInPlace(scopeRef.current, key, chip.name, path);
      }
      return no;
    },
    [dispatch, grantInPlace],
  );

  const onFiles = useCallback(
    (all: readonly File[]) => {
      const host = nativeRef.current;
      const located = all.map((file) => ({ file, path: host?.pathOf(file) ?? null }));
      const inPlace = located.flatMap((l) =>
        l.path === null ? [] : [{ file: l.file, path: l.path }],
      );
      const uploads = located.flatMap((l) => (l.path === null ? [l.file] : []));
      const noInPlace = inPlace.length > 0 ? attachInPlace(inPlace, chipsRef.current.length) : [];
      const { accepted, refused: no } = admitFiles(
        uploads,
        supportRef.current,
        chipsRef.current.length + inPlace.length - noInPlace.length,
      );
      setRefused([...noInPlace, ...no]);
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
      for (const { file, chip } of added) startUpload(scopeRef.current, chip.key, file);
    },
    [attachInPlace, dispatch, startUpload],
  );

  const onRetry = useCallback((key: string) => retries.get(key)?.(), []);

  const onRemove = useCallback(
    (key: string) => {
      aborts.get(key)?.abort();
      aborts.delete(key);
      retries.delete(key);
      dispatch({ type: "remove", key });
    },
    [dispatch],
  );

  const clear = useCallback(() => {
    // The uploads that finished stay in the Library: they were sent.
    for (const c of chipsRef.current) {
      aborts.delete(c.key);
      retries.delete(c.key);
    }
    dispatch({ type: "clear" });
  }, [dispatch]);

  const restore = useCallback(
    (back: readonly AttachmentChip[]) => {
      if (back.length > 0) dispatch({ type: "add", chips: back });
    },
    [dispatch],
  );
  const snapshot = useCallback(() => chipsRef.current, []);

  const addItems = useCallback(
    (items: readonly LibraryAttachItem[]) => {
      const { chips: added, refused: no } = libraryChips(
        items,
        supportRef.current,
        chipsRef.current.length,
      );
      setRefused(no);
      if (added.length > 0) dispatch({ type: "add", chips: added });
    },
    [dispatch],
  );

  // A thread's uploads keep going when its chat unmounts; a private scope goes with its hook.
  useEffect(
    () => () => {
      if (threadId === undefined) {
        const id = scopeRef.current;
        forget(scopes.get(id)?.chips ?? NONE);
        scopes.delete(id);
      }
    },
    [threadId],
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
            onRetry,
            onDismissRefused,
            images: support.images,
          }
        : undefined,
    [show, chips, support, refused, onFiles, onRemove, onRetry, onDismissRefused],
  );
  return {
    attach,
    ids: attachmentIds(chips),
    attachedFiles: attachedPaths(chips),
    uploading: uploading(chips),
    failed: hasFailed(chips),
    clear,
    restore,
    snapshot,
    addItems,
  };
}
