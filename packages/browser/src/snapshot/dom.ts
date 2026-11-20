import { isPaymentField as isMoneyPaymentField } from "@psyche/protocol/money-intent";
import type { CaptureSnapshotResult, DocumentSnapshot, NodeTreeSnapshot } from "../cdp/types.ts";
import { tryOrigin } from "../origin/canonical.ts";
import {
  type FieldFacts,
  isCardNumberValue,
  isLegacySecure,
  isSecureField,
  isStrongSecureField,
  makeScrubber,
} from "./secure-field.ts";

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
  /** Text of a label, an aria-labelledby target or a contenteditable (secret checks only). */
  text?: string;
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

export class DomIndex {
  readonly documents: DomDocumentInfo[] = [];
  readonly #byBackend = new Map<number, DomNodeInfo>();
  /** Nodes by `docIndex:id`, for aria-labelledby. */
  readonly #byId = new Map<string, DomNodeInfo>();
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
      const infos: (DomNodeInfo | undefined)[] = [];
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
        infos[i] = info;
        const idAttr = attrs.id;
        if (idAttr !== undefined && idAttr !== "") this.#byId.set(`${d}:${idAttr}`, info);
      }
      this.#collectText(n, infos, s);
    });
  }

  /**
   * Text under labels, aria-labelledby targets and contenteditables, onto `info.text`: what the
   * secret checks need where the AX tree is not at hand.
   */
  #collectText(n: NodeTreeSnapshot, infos: (DomNodeInfo | undefined)[], strings: string[]): void {
    const parents = n.parentIndex;
    const types = n.nodeType;
    const values = n.nodeValue;
    if (parents === undefined || types === undefined || values === undefined) return;
    const referenced = new Set<string>();
    for (const info of infos) {
      for (const id of (info?.attrs["aria-labelledby"] ?? "").split(/\s+/)) {
        if (id !== "") referenced.add(id);
      }
    }
    const wants = (info: DomNodeInfo | undefined): boolean =>
      info !== undefined &&
      (info.tag === "LABEL" ||
        (info.attrs.contenteditable !== undefined && info.attrs.contenteditable !== "false") ||
        (info.attrs.id !== undefined && referenced.has(info.attrs.id)));
    const want = new Set<number>();
    infos.forEach((info, i) => {
      if (wants(info)) want.add(i);
    });
    if (want.size === 0) return;
    for (let i = 0; i < types.length; i++) {
      if (types[i] !== 3) continue;
      const v = values[i];
      const text = v === undefined || v < 0 ? "" : (strings[v] ?? "").trim();
      if (text === "") continue;
      let j = parents[i] ?? -1;
      for (let guard = 0; j >= 0 && guard < 64; guard++) {
        if (want.has(j)) {
          const info = infos[j];
          if (info !== undefined) info.text = `${info.text ?? ""} ${text}`.trim();
        }
        j = parents[j] ?? -1;
      }
    }
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

  #pwForms = new Map<number, boolean>();

  /** The form holds an `<input type=password>` (computed once per form). */
  formHasPassword(form: DomNodeInfo): boolean {
    const cached = this.#pwForms.get(form.backendNodeId);
    if (cached !== undefined) return cached;
    let found = false;
    for (const n of this.#byBackend.values()) {
      if (
        n.docIndex === form.docIndex &&
        n.tag === "INPUT" &&
        (n.attrs.type ?? "").toLowerCase() === "password" &&
        this.formOf(n)?.backendNodeId === form.backendNodeId
      ) {
        found = true;
        break;
      }
    }
    this.#pwForms.set(form.backendNodeId, found);
    return found;
  }

  #payForms = new Map<number, boolean>();

  /**
   * The form holds a card field (autocomplete `cc-*`, or a name / id such as `card`, `cardnumber`,
   * `cvv`, `cvc`, `expiry`): submitting it pays, whatever the button says.
   */
  formHasPaymentFields(form: DomNodeInfo): boolean {
    const cached = this.#payForms.get(form.backendNodeId);
    if (cached !== undefined) return cached;
    let found = false;
    for (const n of this.#byBackend.values()) {
      if (n.docIndex !== form.docIndex || (n.tag !== "INPUT" && n.tag !== "SELECT")) continue;
      if (this.formOf(n)?.backendNodeId !== form.backendNodeId) continue;
      if (isPaymentField(n.attrs)) {
        found = true;
        break;
      }
    }
    this.#payForms.set(form.backendNodeId, found);
    return found;
  }

  #facts(info: DomNodeInfo, label?: string): FieldFacts {
    const a = info.attrs;
    const max =
      a.maxlength !== undefined && /^\d+$/.test(a.maxlength) ? Number(a.maxlength) : undefined;
    return {
      tag: info.tag,
      type: a.type,
      autocomplete: a.autocomplete,
      name: a.name,
      id: a.id,
      placeholder: a.placeholder,
      ariaLabel: a["aria-label"],
      label,
      contentEditable: a.contenteditable !== undefined && a.contenteditable !== "false",
      maxLength: max,
      search: (a.type ?? "").toLowerCase() === "search" || a.role === "searchbox",
    };
  }

  /**
   * The control's label from the DOM: `aria-label`, `aria-labelledby`, `<label for>` or a wrapping
   * `<label>`. For callers that have no AX name (the screenshot guard).
   */
  labelOf(info: DomNodeInfo): string | undefined {
    const al = info.attrs["aria-label"];
    if (al !== undefined && al !== "") return al;
    const parts: string[] = [];
    for (const id of (info.attrs["aria-labelledby"] ?? "").split(/\s+/)) {
      const t = id === "" ? undefined : this.#byId.get(`${info.docIndex}:${id}`)?.text;
      if (t !== undefined) parts.push(t);
    }
    const own = info.attrs.id;
    if (own !== undefined && own !== "") {
      for (const n of this.#byBackend.values()) {
        if (n.docIndex === info.docIndex && n.tag === "LABEL" && n.attrs.for === own && n.text) {
          parts.push(n.text);
        }
      }
    }
    const wrap = this.ancestor(info, "LABEL");
    if (wrap?.text) parts.push(wrap.text);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }

  /** Typing is refused on it: `type=password` or a secure `autocomplete` (the old criteria). */
  isSecure(info: DomNodeInfo): boolean {
    return isLegacySecure(this.#facts(info));
  }

  /** The control holds a secret by the wide classifier or by its value (a Luhn-valid number). */
  isMasked(info: DomNodeInfo, label?: string): boolean {
    if (!this.#isField(info)) return false;
    if (isSecureField(this.#facts(info, label ?? this.labelOf(info)))) return true;
    return isCardNumberValue(info.inputValue ?? "");
  }

  /** The high-confidence subset: its value refuses screenshots and drops recording frames. */
  isStrong(info: DomNodeInfo, label?: string): boolean {
    if (!this.#isField(info)) return false;
    if (isStrongSecureField(this.#facts(info, label ?? this.labelOf(info)))) return true;
    return isCardNumberValue(info.inputValue ?? "");
  }

  #isField(info: DomNodeInfo): boolean {
    return (
      info.tag === "INPUT" ||
      info.tag === "TEXTAREA" ||
      (info.attrs.contenteditable !== undefined && info.attrs.contenteditable !== "false")
    );
  }

  /** The control's current value or editable text. */
  valueOf(info: DomNodeInfo): string {
    return info.inputValue ?? info.text ?? "";
  }

  /** Some strong secret field in any document holds a value (screenshot guard; no AX tree). */
  anySecureValue(): boolean {
    for (const n of this.#byBackend.values()) {
      if (!this.#isField(n) || this.valueOf(n).trim() === "") continue;
      if (this.isStrong(n)) return true;
    }
    return false;
  }

  #secrets: string[] | undefined;
  #scrubber: ((s: string) => string) | undefined;

  /** Current values of every masked field in the page (the backstop for `scrub`). */
  secretValues(): string[] {
    if (this.#secrets === undefined) {
      const out: string[] = [];
      for (const n of this.#byBackend.values()) {
        if (!this.#isField(n)) continue;
        const v = this.valueOf(n).trim();
        if (v !== "" && this.isMasked(n)) out.push(v);
      }
      this.#secrets = out;
    }
    return this.#secrets;
  }

  /** Replace secret values (also split across text runs) and card numbers in output text. */
  scrub(s: string): string {
    this.#scrubber ??= makeScrubber(this.secretValues(), "•••");
    return this.#scrubber(s);
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

/**
 * A card field by its `autocomplete` (`cc-number`, `cc-exp`, `cc-csc`) or its name, id, label or
 * placeholder (card number, security code, expiry): the shared rule (`money-intent`). Never `cc`
 * alone (email CC), a library card or a card PIN.
 */
export function isPaymentField(attrs: {
  autocomplete?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  placeholder?: string | undefined;
  "aria-label"?: string | undefined;
}): boolean {
  return isMoneyPaymentField({
    autocomplete: attrs.autocomplete,
    name: attrs.name,
    id: attrs.id,
    placeholder: attrs.placeholder,
    label: attrs["aria-label"],
  });
}
