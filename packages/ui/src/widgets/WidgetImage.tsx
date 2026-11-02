import { type ReactElement, useContext, useEffect, useState } from "react";
import { fromBase64, readFileBytes } from "../data/files.ts";
import { useLibraryItem, useSettings, useStore } from "../data/index.ts";
import { t } from "../i18n/core.ts";
import { WidgetContext } from "./context.ts";

/**
 * Widget images (generative-ui-2026 §7.2, D3). Three sources, all drawn as a plain `<img>` with a
 * required alt text and no referrer: a Library file by id (read through `files.read`), a small
 * `data:` image, or a remote https image. Remote images are off unless the owner turned
 * `widgets.remoteImages` on; when on they load through the Gateway (`widgets.image`: no cookies,
 * no referrer, private addresses refused, 512 KiB cap) and, in an untrusted widget, only after a
 * click, so an injected spec cannot use one as a tracking beacon. The page's CSP allows only
 * `self`, `data:` and `blob:` images, so nothing here can reach the network directly.
 */

type N = Record<string, unknown>;
type Mime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
const MIMES = new Set<string>(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const FILE_MAX = 4 * 1024 * 1024;

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "failed" };

function Note({ children }: { children: string }): ReactElement {
  return (
    <p className="rounded-md border border-border border-dashed px-2 py-3 text-callout text-label-secondary">
      {children}
    </p>
  );
}

function Img({ src, alt }: { src: string; alt: string }): ReactElement {
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      className="max-h-80 max-w-full rounded-md border border-border object-contain"
    />
  );
}

/** A blob URL for bytes, revoked when the component leaves. */
function useBlobUrl(): [State, (bytes: Uint8Array, mime: Mime) => void, (s: State) => void] {
  const [state, setState] = useState<State>({ kind: "idle" });
  useEffect(
    () => () => {
      if (state.kind === "ready") URL.revokeObjectURL(state.url);
    },
    [state],
  );
  const set = (bytes: Uint8Array, mime: Mime) =>
    setState({
      kind: "ready",
      url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })),
    });
  return [state, set, setState];
}

function FileImage({ fileId, alt }: { fileId: string; alt: string }): ReactElement {
  const store = useStore();
  const { item, loading } = useLibraryItem(fileId);
  const [state, show, setState] = useBlobUrl();
  const path = item?.path;
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per library path
  useEffect(() => {
    if (!path) return;
    let live = true;
    setState({ kind: "loading" });
    readFileBytes((m, p) => store.call(m, p), { libraryPath: path }, { maxBytes: FILE_MAX })
      .then((r) => {
        if (!live) return;
        if (MIMES.has(r.mime)) show(r.bytes, r.mime as Mime);
        else setState({ kind: "failed" });
      })
      .catch(() => live && setState({ kind: "failed" }));
    return () => {
      live = false;
    };
  }, [path]);
  if (state.kind === "ready") return <Img src={state.url} alt={alt} />;
  if (!loading && item === null) return <Note>{t("widgets.image.failed", { alt })}</Note>;
  return (
    <Note>
      {state.kind === "failed"
        ? t("widgets.image.failed", { alt })
        : t("widgets.image.loading", { alt })}
    </Note>
  );
}

function RemoteImage({ url, alt }: { url: string; alt: string }): ReactElement {
  const ctx = useContext(WidgetContext);
  const { settings } = useSettings();
  const store = useStore();
  const on = settings["widgets.remoteImages"] === true;
  const [state, show, setState] = useBlobUrl();
  const [clicked, setClicked] = useState(false);
  const tainted = ctx?.tainted ?? true;
  const go = on && ctx !== null && (!tainted || clicked);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once when allowed
  useEffect(() => {
    if (!go || ctx === null) return;
    let live = true;
    setState({ kind: "loading" });
    store
      .call("widgets.image", { widgetId: ctx.widgetId, url })
      .then((r) =>
        live && MIMES.has(r.mime)
          ? show(fromBase64(r.bytes), r.mime)
          : live && setState({ kind: "failed" }),
      )
      .catch(() => live && setState({ kind: "failed" }));
    return () => {
      live = false;
    };
  }, [go, url, ctx?.widgetId]);
  if (!on) return <Note>{t("widgets.image.remoteOff", { alt })}</Note>;
  if (state.kind === "ready") return <Img src={state.url} alt={alt} />;
  if (!go) {
    return (
      <button
        type="button"
        className="rounded-md border border-border border-dashed px-2 py-3 text-start text-callout text-label-secondary hover:bg-fill-quaternary"
        onClick={() => setClicked(true)}
      >
        {tainted ? t("widgets.image.loadUntrusted", { alt }) : t("widgets.image.load", { alt })}
      </button>
    );
  }
  return (
    <Note>
      {state.kind === "failed"
        ? t("widgets.image.failed", { alt })
        : t("widgets.image.loading", { alt })}
    </Note>
  );
}

export default function WidgetImage({ node }: { node: N }): ReactElement | null {
  const alt = typeof node.alt === "string" ? node.alt : "";
  const src = (node.src ?? {}) as { fileId?: unknown; dataUrl?: unknown; url?: unknown };
  if (typeof src.dataUrl === "string") {
    return DATA_URL.test(src.dataUrl) ? <Img src={src.dataUrl} alt={alt} /> : null;
  }
  if (typeof src.fileId === "string") return <FileImage fileId={src.fileId} alt={alt} />;
  if (typeof src.url === "string" && src.url.startsWith("https://"))
    return <RemoteImage url={src.url} alt={alt} />;
  return null;
}
