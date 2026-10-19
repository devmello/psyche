import type { CaptureSnapshotResult, DocumentSnapshot } from "../cdp/types.ts";
import { tryOrigin } from "../origin/canonical.ts";

/**
 * Index over `DOMSnapshot.captureSnapshot`: per `backendNodeId`, the tag, attributes, layout
 * box, enclosing form and document. The AX tree says *what* an element is; this says what
 * activating it would do (submit a form, open a popup) and where it lives (frame origin).
 */

export interface DomBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DomNodeInfo {
  backendNodeId: number;
  tag: string;
  attrs: Record<string, string>;
  /** Layout box in CSS pixels, document coordinates. */
  box?: DomBox;
  inputValue?: string;
  checked?: boolean;
  clickable: boolean;
  docIndex: number;
  /** Index of this node in its document's node arrays. */
  index: number;
  /** Document the node's `contentDocumentIndex` points to (iframes). */
  contentDocIndex?: number;
}

export interface DomDocumentInfo {
  url: string;
  origin: string;
  frameId: string;
  title: string;
}

const SECURE_AUTOCOMPLETE = [
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
];

export class DomIndex {
  readonly documents: DomDocumentInfo[] = [];
  readonly #byBackend = new Map<number, DomNodeInfo>();
  readonly #snap: CaptureSnapshotResult;
  /** Large opaque surfaces (canvas, embed, object, video) by area, for sparse-tree detection. */
  readonly opaqueAreas: number[] = [];

  constructor(snap: CaptureSnapshotResult, dpr: number) {
    this.#snap = snap;
    const s = snap.strings;
    const str = (i: number | undefined): string => (i === undefined || i < 0 ? "" : (s[i] ?? ""));
    const scale = dpr > 0 ? dpr : 1;
    snap.documents.forEach((doc, d) => {
      const url = str(doc.documentURL);
      this.documents.push({
        url,
        origin: tryOrigin(url) ?? "null",
        frameId: str(doc.frameId),
        title: str(doc.title),
      });
      const n = doc.nodes;
      const count = n.backendNodeId?.length ?? 0;
      const boxes = new Map<number, number[]>();
      doc.layout.nodeIndex.forEach((ni, li) => {
        const b = doc.layout.bounds[li];
        if (b !== undefined && !boxes.has(ni)) boxes.set(ni, b);
      });
      const inputValues = rareStrings(n.inputValue, s);
      const checked = new Set(n.inputChecked?.index ?? []);
      const clickable = new Set(n.isClickable?.index ?? []);
      const contentDocs = new Map<number, number>();
      n.contentDocumentIndex?.index.forEach((ni, k) => {
        const v = n.contentDocumentIndex?.value[k];
        if (v !== undefined) contentDocs.set(ni, v);
      });
      for (let i = 0; i < count; i++) {
        const backendNodeId = n.backendNodeId?.[i];
        if (backendNodeId === undefined) continue;
        const attrs: Record<string, string> = {};
        const raw = n.attributes?.[i] ?? [];
        for (let k = 0; k + 1 < raw.length; k += 2) {
          attrs[str(raw[k]).toLowerCase()] = str(raw[k + 1]);
        }
        const b = boxes.get(i);
        const info: DomNodeInfo = {
          backendNodeId,
          tag: str(n.nodeName?.[i]).toUpperCase(),
          attrs,
          clickable: clickable.has(i),
          docIndex: d,
          index: i,
        };
        if (b !== undefined && b.length >= 4) {
          info.box = {
            x: (b[0] ?? 0) / scale,
            y: (b[1] ?? 0) / scale,
            width: (b[2] ?? 0) / scale,
            height: (b[3] ?? 0) / scale,
          };
          if (["CANVAS", "EMBED", "OBJECT", "VIDEO"].includes(info.tag)) {
            this.opaqueAreas.push(info.box.width * info.box.height);
          }
        }
        const iv = inputValues.get(i);
        if (iv !== undefined) info.inputValue = iv;
        if (checked.has(i)) info.checked = true;
        const cd = contentDocs.get(i);
        if (cd !== undefined) info.contentDocIndex = cd;
        this.#byBackend.set(backendNodeId, info);
      }
    });
  }

  get(backendNodeId: number | undefined): DomNodeInfo | undefined {
    return backendNodeId === undefined ? undefined : this.#byBackend.get(backendNodeId);
  }

  #doc(info: DomNodeInfo): DocumentSnapshot | undefined {
    return this.#snap.documents[info.docIndex];
  }

  /** Nearest ancestor (or self) with this tag in the same document. */
  ancestor(info: DomNodeInfo, tag: string): DomNodeInfo | undefined {
    const doc = this.#doc(info);
    const parents = doc?.nodes.parentIndex;
    const ids = doc?.nodes.backendNodeId;
    if (parents === undefined || ids === undefined) return undefined;
    let i: number | undefined = info.index;
    let guard = 0;
    while (i !== undefined && i >= 0 && guard++ < 512) {
      const cur = this.#byBackend.get(ids[i] ?? -1);
      if (cur?.tag === tag) return cur;
      i = parents[i];
    }
    return undefined;
  }

  /** The form an element belongs to: `form=` attribute first, then the nearest `<form>`. */
  formOf(info: DomNodeInfo): DomNodeInfo | undefined {
    const formId = info.attrs.form;
    if (formId !== undefined && formId !== "") {
      for (const n of this.#byBackend.values()) {
        if (n.docIndex === info.docIndex && n.tag === "FORM" && n.attrs.id === formId) return n;
      }
    }
    return this.ancestor(info, "FORM");
  }

  isSecure(info: DomNodeInfo): boolean {
    const type = (info.attrs.type ?? "").toLowerCase();
    if (info.tag === "INPUT" && type === "password") return true;
    const ac = (info.attrs.autocomplete ?? "").toLowerCase().split(/\s+/);
    return ac.some((t) => SECURE_AUTOCOMPLETE.includes(t));
  }

  /** Activating the element submits its form. */
  submits(info: DomNodeInfo): boolean {
    const type = (info.attrs.type ?? "").toLowerCase();
    if (info.tag === "BUTTON") {
      return (type === "" || type === "submit") && this.formOf(info) !== undefined;
    }
    if (info.tag === "INPUT") return type === "submit" || type === "image";
    return false;
  }
}

function rareStrings(
  data: { index: number[]; value: number[] } | undefined,
  strings: string[],
): Map<number, string> {
  const m = new Map<number, string>();
  data?.index.forEach((ni, k) => {
    const v = data.value[k];
    if (v !== undefined && v >= 0) m.set(ni, strings[v] ?? "");
  });
  return m;
}
