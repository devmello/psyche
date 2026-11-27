import type { LibraryItem } from "@psyche/protocol";
import { type GatewayCall, readFileBytes, useCall } from "@psyche/ui";
import { type ReactElement, useEffect, useRef, useState } from "react";

/**
 * Library grid thumbnails: an image shows its pixels, a PDF its first page. Built for low RAM:
 * a tile renders only once it nears the viewport, at about twice the card width, two at a time;
 * the PDF document is destroyed right after its first page is drawn; and the result is a small
 * object URL, shared by tiles of the same file and revoked when the last of them unmounts. Any
 * error, a quarantined download or another type keeps the icon tile.
 */

/** The card is at most 160 px wide, so 320 px covers a 2x display. */
const THUMB_WIDTH = 320;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const MAX_CONCURRENT = 2;

type Kind = "image" | "pdf";

export function thumbnailKind(item: LibraryItem): Kind | null {
  if (item.quarantined === true) return null;
  if (item.mime.startsWith("image/") && item.size <= MAX_IMAGE_BYTES) return "image";
  if (item.mime === "application/pdf" && item.size <= MAX_PDF_BYTES) return "pdf";
  return null;
}

let running = 0;
const waiting: (() => void)[] = [];

/** Runs `job` once fewer than two renders are in flight. */
async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await job();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no thumbnail"))), "image/png"),
  );
}

async function imageThumbnail(call: GatewayCall, item: LibraryItem): Promise<Blob> {
  const { bytes } = await readFileBytes(
    call,
    { libraryPath: item.path },
    { maxBytes: MAX_IMAGE_BYTES },
  );
  const source = new Blob([bytes as BlobPart], { type: item.mime });
  // Vector images and hosts without bitmap resizing show the file itself (an <img> never runs it).
  if (item.mime === "image/svg+xml" || typeof createImageBitmap !== "function") return source;
  const bitmap = await createImageBitmap(source);
  try {
    const scale = Math.min(1, THUMB_WIDTH / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (ctx === null) return source;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } finally {
    bitmap.close();
  }
}

async function pdfThumbnail(call: GatewayCall, item: LibraryItem): Promise<Blob> {
  const { bytes } = await readFileBytes(
    call,
    { libraryPath: item.path },
    { maxBytes: MAX_PDF_BYTES },
  );
  const { openPdf } = await import("@psyche/viewers/core");
  const pdf = await openPdf(bytes);
  try {
    const page = await pdf.doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport }).promise;
    page.cleanup();
    const blob = await canvasToBlob(canvas);
    canvas.width = 0;
    return blob;
  } finally {
    await pdf.close();
  }
}

interface CacheEntry {
  url: Promise<string>;
  refs: number;
}
const cache = new Map<string, CacheEntry>();

/** One shared object URL per file version; `release` revokes it with the last user. */
function acquire(call: GatewayCall, item: LibraryItem, kind: Kind): CacheEntry {
  const key = `${item.id}:${item.sha256}`;
  let entry = cache.get(key);
  if (entry === undefined) {
    const make = kind === "pdf" ? pdfThumbnail : imageThumbnail;
    const created: CacheEntry = {
      refs: 0,
      url: limited(() => make(call, item)).then((blob) => URL.createObjectURL(blob)),
    };
    // A failure must not stay cached: the tile falls back and a later mount may retry.
    created.url.catch(() => {
      if (cache.get(key) === created) cache.delete(key);
    });
    cache.set(key, created);
    entry = created;
  }
  entry.refs += 1;
  return entry;
}

function release(item: LibraryItem, entry: CacheEntry): void {
  entry.refs -= 1;
  if (entry.refs > 0) return;
  const key = `${item.id}:${item.sha256}`;
  if (cache.get(key) === entry) cache.delete(key);
  entry.url.then(
    (url) => URL.revokeObjectURL(url),
    () => undefined,
  );
}

function Thumbnail({
  item,
  kind,
  fallback,
}: {
  item: LibraryItem;
  kind: Kind;
  fallback: ReactElement;
}): ReactElement {
  const call = useCall() as GatewayCall;
  const ref = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (el === null || near) return;
    if (typeof IntersectionObserver !== "function") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [near]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the file's identity
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    const entry = acquire(call, item, kind);
    entry.url.then(
      (u) => {
        if (!cancelled) setUrl(u);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      setUrl(null);
      release(item, entry);
    };
  }, [near, call, item.id, item.sha256, kind]);

  return (
    <span ref={ref} className="flex size-full items-center justify-center">
      {url !== null ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="size-full object-contain"
          onError={() => setUrl(null)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

/** `renderThumbnail` for the Library: the preview where there is one, else the icon tile. */
export function renderLibraryThumbnail(item: LibraryItem, fallback: ReactElement): ReactElement {
  const kind = thumbnailKind(item);
  if (kind === null) return fallback;
  return <Thumbnail item={item} kind={kind} fallback={fallback} />;
}
