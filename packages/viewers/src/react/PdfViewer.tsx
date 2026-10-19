import type { PDFPageProxy } from "pdfjs-dist/types/src/display/api.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  openPdf,
  type PdfFormField,
  type PdfHandle,
  type PdfOutlineNode,
  type PdfSearchHit,
} from "../core/pdf.ts";
import { loadPdfJs } from "../core/pdfjs.ts";
import type { ViewerProps } from "./contract.ts";
import { Toolbar, ViewerMessage } from "./states.tsx";
import { useLoadable } from "./useBytes.ts";

/** Pages rendered above and below the visible range. */
const OVERSCAN = 2;
const GAP = 12;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

interface Opened {
  pdf: PdfHandle;
  bytes: Uint8Array;
  fields: PdfFormField[];
  outline: PdfOutlineNode[];
  /** Page 1 size at scale 1 (pages of other sizes adjust once rendered). */
  base: { width: number; height: number };
}

export interface PdfViewerProps extends ViewerProps {
  /** Values the agent proposes for AcroForm fields (docs/06 §3.7): outlined, editable, then Apply. */
  proposedValues?: Record<string, string | boolean>;
}

/**
 * PDF viewer (P1): PDF.js 6 with a self-hosted worker, virtualized pages (a 100-page PDF keeps
 * about five canvases alive), text selection, search, outline, AcroForm highlights and values with
 * a fill preview, an explicit "XFA not supported" state, export and print. Document JavaScript
 * never runs.
 */
export function PdfViewer(props: PdfViewerProps) {
  const { item, load } = props;
  const state = useLoadable(item.id, async (signal) => {
    const bytes = await load(signal);
    const pdf = await openPdf(bytes);
    if (signal.aborted) {
      await pdf.close();
      throw new DOMException("aborted", "AbortError");
    }
    const [fields, outline, first] = await Promise.all([
      pdf.fields(),
      pdf.outline(),
      pdf.doc.getPage(1),
    ]);
    const vp = first.getViewport({ scale: 1 });
    return {
      pdf,
      bytes,
      fields,
      outline,
      base: { width: vp.width, height: vp.height },
    } satisfies Opened;
  });
  useEffect(() => {
    if (state.status !== "ready") return;
    const pdf = state.value.pdf;
    return () => void pdf.close();
  }, [state]);

  if (state.status === "loading")
    return <ViewerMessage kind="loading" title={`Opening ${item.name}…`} />;
  if (state.status === "error") {
    const pw = state.error.name === "PdfPasswordError";
    return (
      <ViewerMessage
        kind="error"
        title={pw ? "This PDF is password-protected" : "This PDF could not be opened"}
        detail={pw ? undefined : state.error.message}
      />
    );
  }
  if (state.value.pdf.info.isPureXfa) {
    return (
      <ViewerMessage
        kind="unsupported"
        title="XFA forms are not supported"
        detail="This PDF is a dynamic XFA form (Adobe LiveCycle). Psyche cannot show or fill it. Open it in Adobe Acrobat, or ask the sender for a standard PDF form."
      />
    );
  }
  return <PdfDocumentView {...props} opened={state.value} />;
}

function PdfDocumentView(props: PdfViewerProps & { opened: Opened }) {
  const { opened, item } = props;
  const { pdf, base } = opened;
  const n = pdf.info.numPages;
  const [zoom, setZoom] = useState(props.pageState?.zoom ?? 1);
  const [page, setPage] = useState(props.pageState?.page ?? 1);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PdfSearchHit[]>([]);
  const [hitIndex, setHitIndex] = useState(0);
  const [showOutline, setShowOutline] = useState(false);
  const [values, setValues] = useState<Record<string, string | boolean | string[]>>(() =>
    initialValues(opened.fields, props.proposedValues),
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0 });
  const pageHeight = base.height * zoom + GAP;

  const first = Math.max(1, Math.floor(scroll.top / pageHeight) + 1 - OVERSCAN);
  const visibleCount = Math.max(1, Math.ceil((scroll.height || pageHeight * 2) / pageHeight));
  const last = Math.min(n, first + visibleCount + OVERSCAN * 2);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (el === null) return;
    setScroll({ top: el.scrollTop, height: el.clientHeight });
    const current = Math.min(n, Math.max(1, Math.round(el.scrollTop / pageHeight) + 1));
    setPage(current);
  }, [n, pageHeight]);

  useEffect(() => {
    onScroll();
  }, [onScroll]);

  const { onPageStateChange } = props;
  useEffect(() => {
    onPageStateChange?.({ page, zoom });
  }, [page, zoom, onPageStateChange]);

  const goTo = useCallback(
    (p: number) => {
      const target = Math.min(n, Math.max(1, p));
      setPage(target);
      const el = scroller.current;
      if (el !== null) {
        el.scrollTop = (target - 1) * pageHeight;
        setScroll({ top: el.scrollTop, height: el.clientHeight });
      }
    },
    [n, pageHeight],
  );

  const runSearch = async (q: string) => {
    setQuery(q);
    const found = q.trim() === "" ? [] : await pdf.search(q);
    setHits(found);
    setHitIndex(0);
    if (found[0] !== undefined) goTo(found[0].page);
  };

  const fieldsByPage = useMemo(() => {
    const m = new Map<number, PdfFormField[]>();
    for (const f of opened.fields) m.set(f.page, [...(m.get(f.page) ?? []), f]);
    return m;
  }, [opened.fields]);

  const exportPdf = async () => {
    const bytes = await pdf.doc.saveDocument();
    props.onSaveToLibrary?.({ name: item.name, mime: "application/pdf", bytes });
  };

  const applyFill = async () => {
    const filled = await pdf.fillPreview(values);
    props.onSaveToLibrary?.({
      name: item.name.replace(/\.pdf$/i, "") + " (filled).pdf",
      mime: "application/pdf",
      bytes: filled,
    });
  };

  const print = () => {
    const blob = new Blob([opened.bytes.slice()], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const frame = document.createElement("iframe");
    frame.style.display = "none";
    frame.src = url;
    frame.onload = () => frame.contentWindow?.print();
    document.body.appendChild(frame);
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  };

  return (
    <div className="psy-pdf" data-compact={props.compact ? "" : undefined}>
      <Toolbar label="PDF">
        <button
          type="button"
          aria-label="Outline"
          aria-pressed={showOutline}
          onClick={() => setShowOutline((v) => !v)}
          disabled={opened.outline.length === 0}
        >
          Outline
        </button>
        <label>
          Page{" "}
          <input
            aria-label="Page number"
            type="number"
            min={1}
            max={n}
            value={page}
            onChange={(e) => goTo(Number(e.target.value))}
          />{" "}
          of {n}
        </label>
        <button type="button" aria-label="Zoom out" onClick={() => setZoom(stepZoom(zoom, -1))}>
          −
        </button>
        <span aria-label="Zoom level">{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => setZoom(stepZoom(zoom, 1))}>
          +
        </button>
        <button
          type="button"
          aria-label="Fit width"
          onClick={() => {
            const w = scroller.current?.clientWidth ?? 0;
            if (w > 0) setZoom(Math.max(0.25, (w - 24) / base.width));
          }}
        >
          Fit
        </button>
        <input
          aria-label="Search in document"
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            if (hits.length > 0 && query === e.currentTarget.value && hits.length > 1) {
              const next = (hitIndex + 1) % hits.length;
              setHitIndex(next);
              goTo(hits[next]?.page ?? page);
            } else void runSearch(e.currentTarget.value);
          }}
        />
        {query !== "" ? (
          <span aria-live="polite">
            {hits.length === 0 ? "No matches" : `${hitIndex + 1} / ${hits.length}`}
          </span>
        ) : null}
        {props.onSaveToLibrary ? (
          <button type="button" onClick={() => void exportPdf()}>
            Export
          </button>
        ) : null}
        <button type="button" onClick={print}>
          Print
        </button>
        {props.onSendToChat ? (
          <button
            type="button"
            onClick={() => props.onSendToChat?.({ itemId: item.id, name: item.name })}
          >
            Send to chat
          </button>
        ) : null}
      </Toolbar>
      <div className="psy-pdf__body">
        {showOutline ? <Outline nodes={opened.outline} onGo={goTo} /> : null}
        <div
          ref={scroller}
          className="psy-pdf__pages"
          onScroll={onScroll}
          onMouseUp={() => {
            const text = window.getSelection()?.toString() ?? "";
            props.onSelectionChange?.(
              text.trim() === "" ? null : { kind: "text", text: text.slice(0, 4000), page },
            );
          }}
          data-testid="pdf-pages"
        >
          <div style={{ height: n * pageHeight, position: "relative" }}>
            {range(first, last).map((p) => (
              <div
                key={p}
                style={{ position: "absolute", top: (p - 1) * pageHeight, left: 0, right: 0 }}
              >
                <PdfPage
                  pdf={pdf}
                  page={p}
                  zoom={zoom}
                  base={base}
                  fields={fieldsByPage.get(p) ?? []}
                  values={values}
                  highlight={hits[hitIndex]?.page === p ? query : ""}
                />
              </div>
            ))}
          </div>
        </div>
        {opened.fields.length > 0 ? (
          <FieldList
            fields={opened.fields}
            values={values}
            proposed={props.proposedValues ?? {}}
            onChange={setValues}
            onApply={props.onSaveToLibrary ? () => void applyFill() : undefined}
            onDiscard={() => setValues(initialValues(opened.fields, props.proposedValues))}
            onFocus={(f) => goTo(f.page)}
          />
        ) : null}
      </div>
    </div>
  );
}

function initialValues(fields: PdfFormField[], proposed?: Record<string, string | boolean>) {
  const out: Record<string, string | boolean | string[]> = {};
  for (const f of fields) {
    const p = proposed?.[f.name];
    if (p !== undefined && !f.readOnly) out[f.name] = p;
    else if (f.value !== null) out[f.name] = f.value;
  }
  return out;
}

const stepZoom = (z: number, dir: 1 | -1) => {
  if (dir > 0) return ZOOMS.find((v) => v > z + 1e-6) ?? z;
  return [...ZOOMS].reverse().find((v) => v < z - 1e-6) ?? z;
};

let measurable: boolean | undefined;
function canMeasureText(): boolean {
  measurable ??= document.createElement("canvas").getContext("2d") !== null;
  return measurable;
}

const range = (a: number, b: number) =>
  Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

function Outline(props: { nodes: PdfOutlineNode[]; onGo: (page: number) => void }) {
  const render = (nodes: PdfOutlineNode[]) => (
    <ul>
      {nodes.map((node, i) => (
        <li key={`${node.title}-${i}`}>
          <button
            type="button"
            disabled={node.page === undefined}
            onClick={() => node.page !== undefined && props.onGo(node.page)}
          >
            {node.title}
          </button>
          {node.children.length > 0 ? render(node.children) : null}
        </li>
      ))}
    </ul>
  );
  return (
    <nav className="psy-pdf__outline" aria-label="Outline">
      {render(props.nodes)}
    </nav>
  );
}

function PdfPage(props: {
  pdf: PdfHandle;
  page: number;
  zoom: number;
  base: { width: number; height: number };
  fields: PdfFormField[];
  values: Record<string, unknown>;
  highlight: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [proxy, setProxy] = useState<PDFPageProxy | null>(null);
  const { pdf, page, zoom } = props;

  useEffect(() => {
    let live = true;
    void pdf.doc.getPage(page).then((p) => live && setProxy(p));
    return () => {
      live = false;
    };
  }, [pdf, page]);

  const viewport = useMemo(() => proxy?.getViewport({ scale: zoom }), [proxy, zoom]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (proxy === null || viewport === undefined || canvas === null) return;
    // jsdom and other DOM-less hosts: skip painting, keep the text layer.
    if (canvas.getContext("2d") === null) return;
    const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    const task = proxy.render({ canvas, viewport: proxy.getViewport({ scale: zoom * ratio }) });
    task.promise.catch(() => undefined);
    return () => task.cancel();
  }, [proxy, viewport, zoom]);

  useEffect(() => {
    const container = textRef.current;
    if (proxy === null || viewport === undefined || container === null) return;
    // The text layer measures glyphs with a 2D context; hosts without one (jsdom) skip it.
    if (!canMeasureText()) return;
    let cancelled = false;
    let layer: { cancel(): void } | undefined;
    void (async () => {
      const lib = await loadPdfJs();
      if (cancelled) return;
      container.replaceChildren();
      container.style.setProperty("--scale-factor", String(zoom));
      try {
        const tl = new lib.TextLayer({
          textContentSource: proxy.streamTextContent(),
          container,
          viewport,
        });
        layer = tl;
        await tl.render();
      } catch {
        // Hosts without canvas text metrics (jsdom) get no text layer; the page still shows.
        return;
      }
      if (cancelled || props.highlight === "") return;
      const q = props.highlight.toLowerCase();
      for (const span of container.querySelectorAll("span")) {
        if (span.textContent?.toLowerCase().includes(q)) span.classList.add("psy-pdf__hit");
      }
    })();
    return () => {
      cancelled = true;
      layer?.cancel();
    };
  }, [proxy, viewport, zoom, props.highlight]);

  const width = viewport?.width ?? props.base.width * zoom;
  const height = viewport?.height ?? props.base.height * zoom;
  return (
    <div
      className="psy-pdf__page"
      style={{ width, height, position: "relative", margin: "0 auto" }}
      data-page={page}
      aria-label={`Page ${page}`}
    >
      <canvas ref={canvasRef} style={{ width, height, display: "block" }} />
      <div
        ref={textRef}
        className="textLayer psy-pdf__text"
        style={{ position: "absolute", inset: 0 }}
      />
      {viewport === undefined
        ? null
        : props.fields.map((f) => {
            const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(
              f.rect[0],
              f.rect[1],
            ) as number[];
            const [x2 = 0, y2 = 0] = viewport.convertToViewportPoint(
              f.rect[2],
              f.rect[3],
            ) as number[];
            return (
              <div
                key={f.id}
                className="psy-pdf__field"
                data-field={f.name}
                title={f.name}
                style={{
                  position: "absolute",
                  left: Math.min(x1, x2),
                  top: Math.min(y1, y2),
                  width: Math.abs(x2 - x1),
                  height: Math.abs(y2 - y1),
                  pointerEvents: "none",
                }}
              />
            );
          })}
    </div>
  );
}

function FieldList(props: {
  fields: PdfFormField[];
  values: Record<string, string | boolean | string[]>;
  proposed: Record<string, string | boolean>;
  onChange: (v: Record<string, string | boolean | string[]>) => void;
  onApply: (() => void) | undefined;
  onDiscard: () => void;
  onFocus: (f: PdfFormField) => void;
}) {
  const { values, proposed } = props;
  const needYou = props.fields.filter(
    (f) => !f.readOnly && (values[f.name] === undefined || values[f.name] === ""),
  ).length;
  const set = (name: string, v: string | boolean) => props.onChange({ ...values, [name]: v });
  return (
    <aside className="psy-pdf__fields" aria-label="Form fields">
      <p>
        {props.fields.length} fields · {needYou} need you
      </p>
      <ul>
        {props.fields.map((f) => {
          const v = values[f.name];
          const source =
            proposed[f.name] !== undefined && v === proposed[f.name]
              ? "agent"
              : v === undefined || v === ""
                ? "you"
                : "";
          return (
            <li key={f.id} data-source={source}>
              <label onFocus={() => props.onFocus(f)}>
                <span>{f.name}</span>
                {f.type === "checkbox" ? (
                  <input
                    type="checkbox"
                    checked={v === true}
                    disabled={f.readOnly}
                    onChange={(e) => set(f.name, e.target.checked)}
                  />
                ) : f.type === "choice" && f.options !== undefined ? (
                  <select
                    value={Array.isArray(v) ? (v[0] ?? "") : String(v ?? "")}
                    disabled={f.readOnly}
                    onChange={(e) => set(f.name, e.target.value)}
                  >
                    <option value="" />
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={typeof v === "string" ? v : ""}
                    readOnly={f.readOnly}
                    maxLength={f.maxLen}
                    onChange={(e) => set(f.name, e.target.value)}
                  />
                )}
              </label>
              {source === "" ? null : <small>{source}</small>}
            </li>
          );
        })}
      </ul>
      <div>
        {props.onApply ? (
          <button type="button" onClick={props.onApply}>
            Apply fill
          </button>
        ) : null}
        <button type="button" onClick={props.onDiscard}>
          Discard
        </button>
      </div>
    </aside>
  );
}
