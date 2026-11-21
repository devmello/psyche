import { createHash } from "node:crypto";
import { isPaymentField as isMoneyPaymentField } from "@psyche/protocol/money-intent";
import type { CaptureSnapshotResult, DocumentSnapshot, NodeTreeSnapshot } from "../cdp/types.ts";
import { tryOrigin } from "../origin/canonical.ts";
import {
  blocksScreenshot,
  classifyField,
  type FieldFacts,
  isCardNumberValue,
  isLegacySecure,
  MAX_SECRETS,
  makeScrubber,
  type Scrubber,
  SECRET_REACH,
  type SecureClass,
  secretKeys,
  TEXT_CAP,
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
  /** String-table index of `inputValue` (equal values share one: a per-value memo key). */
  valueId?: number;
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
  /** `<label for>` text by `docIndex:id` (built once, so a label lookup is O(1)). */
  readonly #labelFor = new Map<string, string>();
  /** `<form id>` by `docIndex:id`, for the `form=` attribute. */
  readonly #formById = new Map<string, DomNodeInfo>();
  /** One of four or more sibling (or cousin) one-character text inputs: a split OTP. */
  readonly #splitBoxes = new Set<number>();
  /** Every field (input, textarea, contenteditable), in document order. */
  readonly #fields: DomNodeInfo[] = [];
  /** Parent and grandparent node index of each field, for grouping split boxes. */
  readonly #fieldParents = new Map<number, [number, number]>();
  readonly #snap: CaptureSnapshotResult;
  /** Large opaque surfaces (canvas, embed, object, video) by area, for sparse-tree detection. */
  readonly opaqueAreas: number[] = [];

  /**
   * Values seen in a `type=password` field earlier, per document: a reveal toggle, or a page
   * that re-creates the field as text, keeps that value a password in the same document.
   */
  readonly #wasPassword: PasswordMemory | undefined;

  constructor(
    snap: CaptureSnapshotResult,
    dpr: number,
    options: { wasPassword?: PasswordMemory } = {},
  ) {
    this.#snap = snap;
    this.#wasPassword = options.wasPassword;
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
      const valueIds = new Map<number, number>();
      n.inputValue?.index.forEach((ni, k) => {
        const v = n.inputValue?.value[k];
        if (v !== undefined && v >= 0) valueIds.set(ni, v);
      });
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
        if (iv !== undefined) {
          info.inputValue = iv;
          const vid = valueIds.get(i);
          if (vid !== undefined) info.valueId = vid;
        }
        if (checked.has(i)) info.checked = true;
        const cd = contentDocs.get(i);
        if (cd !== undefined) info.contentDocIndex = cd;
        this.#byBackend.set(backendNodeId, info);
        infos[i] = info;
        const idAttr = attrs.id;
        if (idAttr !== undefined && idAttr !== "") {
          this.#byId.set(`${d}:${idAttr}`, info);
          if (info.tag === "FORM" && !this.#formById.has(`${d}:${idAttr}`)) {
            this.#formById.set(`${d}:${idAttr}`, info);
          }
        }
      }
      this.#collectText(n, infos, s);
      this.#indexFields(d, n, infos);
    });
  }

  /** Label texts, the field list and split-OTP groups, once per document. */
  #indexFields(d: number, n: NodeTreeSnapshot, infos: (DomNodeInfo | undefined)[]): void {
    const parents = n.parentIndex ?? [];
    const oneChar: number[] = [];
    const counts = new Map<number, number>();
    const bump = (k: number) => counts.set(k, (counts.get(k) ?? 0) + 1);
    infos.forEach((info, i) => {
      if (info === undefined) return;
      if (info.tag === "LABEL" && info.text && info.attrs.for) {
        const k = `${d}:${info.attrs.for}`;
        const prev = this.#labelFor.get(k);
        // Many labels for one id are joined up to TEXT_CAP (a hostile page repeats them).
        if (prev === undefined) this.#labelFor.set(k, clipText(info.text));
        else if (prev.length < TEXT_CAP) this.#labelFor.set(k, clipText(`${prev} ${info.text}`));
      }
      if (!isField(info)) return;
      this.#fields.push(info);
      const p = parents[i] ?? -1;
      const gp = p >= 0 ? (parents[p] ?? -1) : -1;
      this.#fieldParents.set(info.backendNodeId, [p, gp]);
      const type = (info.attrs.type ?? "text").toLowerCase();
      if (
        info.tag === "INPUT" &&
        info.attrs.maxlength === "1" &&
        ["text", "tel", "number", "password", ""].includes(type)
      ) {
        oneChar.push(i);
        if (p >= 0) bump(p);
        if (gp >= 0) bump(-gp - 2);
      }
    });
    // An OTP is 4-8 boxes; a page with more one-character inputs is a puzzle grid (a crossword,
    // a Wordle clone), not a code.
    if (oneChar.length > 16) return;
    const otpGroup = (k: number | undefined) => k !== undefined && k >= 4 && k <= 8;
    for (const i of oneChar) {
      const p = parents[i] ?? -1;
      const gp = p >= 0 ? (parents[p] ?? -1) : -1;
      if (otpGroup(counts.get(p)) || (gp >= 0 && otpGroup(counts.get(-gp - 2)))) {
        const info = infos[i];
        if (info !== undefined) this.#splitBoxes.add(info.backendNodeId);
      }
    }
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
    const seen = new Set<string>();
    for (const info of infos) {
      const refs = info?.attrs["aria-labelledby"];
      if (refs === undefined || refs === "" || seen.has(refs)) continue;
      seen.add(refs);
      for (const id of labelledByIds(refs)) referenced.add(id);
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
    // Parts per node, joined once; each node keeps at most TEXT_CAP characters (a label or a
    // secret value is short; a long editor document is not either).
    const parts = new Map<number, { list: string[]; size: number }>();
    for (let i = 0; i < types.length; i++) {
      if (types[i] !== 3) continue;
      const v = values[i];
      const text = v === undefined || v < 0 ? "" : (strings[v] ?? "").trim();
      if (text === "") continue;
      let j = parents[i] ?? -1;
      for (let guard = 0; j >= 0 && guard < 64; guard++) {
        if (want.has(j)) {
          let acc = parts.get(j);
          if (acc === undefined) {
            acc = { list: [], size: 0 };
            parts.set(j, acc);
          }
          if (acc.size < TEXT_CAP) {
            const piece =
              text.length > TEXT_CAP - acc.size ? text.slice(0, TEXT_CAP - acc.size) : text;
            acc.list.push(piece);
            acc.size += piece.length + 1;
          }
        }
        j = parents[j] ?? -1;
      }
    }
    for (const [j, acc] of parts) {
      const info = infos[j];
      if (info !== undefined) info.text = acc.list.join(" ");
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
      const f = this.#formById.get(`${info.docIndex}:${formId}`);
      if (f !== undefined) return f;
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
      title: a.title,
      label,
      contentEditable: a.contenteditable !== undefined && a.contenteditable !== "false",
      maxLength: max,
      inputMode: a.inputmode,
      search: (a.type ?? "").toLowerCase() === "search" || a.role === "searchbox",
      splitBox: this.#splitBoxes.has(info.backendNodeId),
      wasPassword: this.#wasPasswordValue(info),
    };
  }

  /** The memory key of a document: its frame and origin. */
  docKey(d: number): string {
    const doc = this.documents[d];
    return doc === undefined ? `?${d}` : `${doc.frameId}|${doc.origin}`;
  }

  readonly #wasPw = new WeakMap<DomNodeInfo, boolean>();

  /**
   * The field holds a value that sat in a `type=password` field earlier in the same document.
   * Once per field, and hashed only when the memory holds a value of the same length there.
   */
  #wasPasswordValue(info: DomNodeInfo): boolean {
    const mem = this.#wasPassword;
    if (mem === undefined || mem.size === 0) return false;
    const hit = this.#wasPw.get(info);
    if (hit !== undefined) return hit;
    const doc = this.docKey(info.docIndex);
    let out = false;
    if (mem.hasLength(doc, this.valueOf(info).length)) {
      const key = this.#passwordKeyOf(info);
      out = key !== undefined && mem.has(doc, key);
    }
    this.#wasPw.set(info, out);
    return out;
  }

  // --- the per-value memo and the fold budget ---

  /** Scrubber keys per distinct value (its string-table index, or a short text itself). */
  readonly #keysMemo = new Map<number | string, string[]>();
  readonly #pwKeyMemo = new Map<number | string, string>();
  /** Value characters folded so far; past `FOLD_BUDGET` the page fails closed. */
  #folded = 0;
  #foldOver = false;

  /** The memo key of a field's value; undefined for a long value with no string-table index. */
  #memoKey(info: DomNodeInfo): number | string | undefined {
    if (info.inputValue !== undefined) {
      if (info.valueId !== undefined) return info.valueId;
      // V8 hashes a string over 16K characters by its length only: not a Map key.
      return info.inputValue.length <= 16_384 ? `s${info.inputValue}` : undefined;
    }
    return `s${info.text ?? ""}`;
  }

  /** `secretKeys` of the field's value, once per distinct value, charged to the fold budget. */
  #keysOf(info: DomNodeInfo): string[] | undefined {
    const mk = this.#memoKey(info);
    const hit = mk === undefined ? undefined : this.#keysMemo.get(mk);
    if (hit !== undefined) return hit;
    if (this.#foldOver) return undefined;
    const v = this.valueOf(info);
    this.#folded += Math.min(v.length, SECRET_REACH);
    if (this.#folded > FOLD_BUDGET) {
      this.#foldOver = true;
      return undefined;
    }
    const keys = secretKeys(v);
    if (mk !== undefined) this.#keysMemo.set(mk, keys);
    return keys;
  }

  /** `passwordKey` of the field's value, once per distinct value. */
  #passwordKeyOf(info: DomNodeInfo): string | undefined {
    if (this.valueOf(info).trim() === "") return undefined;
    const mk = this.#memoKey(info);
    const hit = mk === undefined ? undefined : this.#pwKeyMemo.get(mk);
    if (hit !== undefined) return hit;
    const keys = this.#keysOf(info);
    if (keys === undefined) return undefined;
    const key = hashKeys(keys);
    if (mk !== undefined) this.#pwKeyMemo.set(mk, key);
    return key;
  }

  /** Past a cap (secret keys, or the fold budget): every field counts as a strong secret. */
  #failClosed(): boolean {
    return this.#secretState().overCap || this.#foldOver;
  }

  /**
   * The control's label from the DOM: `aria-label`, `aria-labelledby`, `<label for>` or a wrapping
   * `<label>`. For callers that have no AX name (the screenshot guard).
   */
  labelOf(info: DomNodeInfo): string | undefined {
    const al = info.attrs["aria-label"];
    if (al !== undefined && al !== "") return clipText(al);
    // Joined up to TEXT_CAP, each labelled-by id once: a hostile page that points every field
    // at the same long text many times costs fields x TEXT_CAP, not fields x refs x text.
    const parts: string[] = [];
    let size = 0;
    const take = (t: string | undefined): boolean => {
      if (t === undefined || t === "") return size < TEXT_CAP;
      parts.push(t.length > TEXT_CAP - size ? t.slice(0, TEXT_CAP - size) : t);
      size += t.length + 1;
      return size < TEXT_CAP;
    };
    const refs = info.attrs["aria-labelledby"];
    if (refs !== undefined && refs !== "") {
      for (const id of labelledByIds(refs)) {
        if (!take(this.#byId.get(`${info.docIndex}:${id}`)?.text)) break;
      }
    }
    const own = info.attrs.id;
    if (size < TEXT_CAP && own !== undefined && own !== "") {
      take(this.#labelFor.get(`${info.docIndex}:${own}`));
    }
    if (size < TEXT_CAP) take(this.ancestor(info, "LABEL")?.text);
    return parts.length > 0 ? parts.join(" ") : undefined;
  }

  /**
   * Keys of the values in the page's `type=password` inputs, to remember across a reveal toggle
   * or a re-created field (`rememberPasswords`).
   */
  passwordFields(): PasswordEntry[] {
    const out: PasswordEntry[] = [];
    for (const n of this.#fields) {
      if (n.tag === "INPUT" && (n.attrs.type ?? "").toLowerCase() === "password") {
        const key = this.#passwordKeyOf(n);
        if (key === undefined) continue;
        out.push({ doc: this.docKey(n.docIndex), key, length: this.valueOf(n).length });
      }
    }
    return out;
  }

  /** Typing is refused on it: `type=password` or a secure `autocomplete` (the old criteria). */
  isSecure(info: DomNodeInfo): boolean {
    return isLegacySecure(this.#facts(info));
  }

  readonly #domClass = new Map<number, SecureClass | null>();

  /** The classifier's verdict, or `strong` for a Luhn-valid card number in any field. */
  #classifyRaw(info: DomNodeInfo, label?: string): SecureClass | undefined {
    if (!isField(info)) return undefined;
    const viaDom = label === undefined;
    if (viaDom) {
      const hit = this.#domClass.get(info.backendNodeId);
      if (hit !== undefined) return hit ?? undefined;
    }
    const c =
      classifyField(this.#facts(info, label ?? this.labelOf(info))) ??
      (isCardNumberValue(info.inputValue ?? "") ? STRONG : undefined);
    if (viaDom) this.#domClass.set(info.backendNodeId, c ?? null);
    return c;
  }

  /**
   * The field's secret class (`label`: the AX name when the caller has it). Above `MAX_SECRETS`
   * filled secret fields every field counts as a strong secret (fail closed).
   */
  classify(info: DomNodeInfo, label?: string): SecureClass | undefined {
    if (!isField(info)) return undefined;
    if (this.#failClosed()) return STRONG;
    return this.#classifyRaw(info, label);
  }

  /** The control holds a secret: any level, or a Luhn-valid value. */
  isMasked(info: DomNodeInfo, label?: string): boolean {
    return this.classify(info, label) !== undefined;
  }

  /** A filled field like this refuses screenshots (legacy and strong; weak by its value). */
  blocksScreenshot(info: DomNodeInfo, label?: string, value?: string): boolean {
    return blocksScreenshot(this.classify(info, label), value ?? this.valueOf(info));
  }

  /** The control's current value or editable text. */
  valueOf(info: DomNodeInfo): string {
    return info.inputValue ?? info.text ?? "";
  }

  /** Some filled field in any document refuses screenshots (the guard that needs no AX tree). */
  anySecureValue(): boolean {
    if (this.#failClosed()) return true;
    for (const n of this.#fields) {
      const v = this.valueOf(n);
      if (v.trim() === "") continue;
      if (blocksScreenshot(this.#classifyRaw(n), v)) return true;
    }
    return this.#foldOver;
  }

  #secrets: { values: string[]; overCap: boolean } | undefined;
  #scrubber: Scrubber | undefined;

  /**
   * Scrubber keys for the page's masked fields that look like secrets (the backstop for
   * `scrub`): legacy and strong values whatever their shape, and weak ones of the secret's shape.
   * A long value counts as its pieces (`secretKeys`). Short values (one-character split boxes)
   * count joined, per container. Past `MAX_SECRETS` keys the first ones are kept and `overCap`
   * is set: every field is masked, screenshots are refused and every 4+ digit run is masked too.
   * Each distinct value is folded once; past `FOLD_BUDGET` folded characters the page is over
   * the cap too.
   */
  #secretState(): { values: string[]; overCap: boolean } {
    if (this.#secrets !== undefined) return this.#secrets;
    const values = new Set<string>();
    const perParent = new Map<string, number>();
    const shortFields: [DomNodeInfo, string][] = [];
    let overCap = false;
    const add = (k: string): void => {
      if (values.has(k)) return;
      if (values.size >= MAX_SECRETS) overCap = true;
      else values.add(k);
    };
    for (const n of this.#fields) {
      if (overCap) break;
      const raw = this.valueOf(n);
      if (raw.trim() === "") continue;
      const c = this.#classifyRaw(n);
      if (c === undefined || (c.level === "weak" && !blocksScreenshot(c, raw))) continue;
      const keys = this.#keysOf(n);
      if (keys === undefined) {
        overCap = true;
        break;
      }
      const v = keys[0] ?? "";
      if (keys.length > 1 || v.length >= 4) {
        for (const k of keys) add(k);
      } else if (v.length > 0) {
        shortFields.push([n, v]);
        const p = `${n.docIndex}:${this.#fieldParents.get(n.backendNodeId)?.[0] ?? -1}`;
        perParent.set(p, (perParent.get(p) ?? 0) + 1);
      }
    }
    const joined = new Map<string, string>();
    for (const [n, v] of shortFields) {
      const [p, gp] = this.#fieldParents.get(n.backendNodeId) ?? [-1, -1];
      const key =
        (perParent.get(`${n.docIndex}:${p}`) ?? 0) >= 2
          ? `${n.docIndex}:${p}`
          : `${n.docIndex}:g${gp}`;
      const prev = joined.get(key) ?? "";
      if (prev.length < 256) joined.set(key, prev + v);
    }
    if (!overCap) for (const j of joined.values()) if (j.length >= 4) add(j);
    this.#secrets = { values: [...values], overCap };
    return this.#secrets;
  }

  /** Current values of every masked field in the page. */
  secretValues(): string[] {
    return this.#secretState().values;
  }

  /**
   * More secret keys than are tracked, or more value text than the fold budget: every field is
   * masked and screenshots are refused.
   */
  get overCap(): boolean {
    return this.#failClosed();
  }

  /** The page holds secret values the scrubber looks for. */
  get hasSecrets(): boolean {
    return this.#failClosed() || this.#secretState().values.length > 0;
  }

  get scrubber(): Scrubber {
    this.#scrubber ??= makeScrubber(this.secretValues(), "•••", { failClosed: this.overCap });
    return this.#scrubber;
  }

  /** Replace secret values (also split or disguised) and card numbers in output text. */
  scrub(s: string): string {
    return this.scrubber.scrub(s);
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

const STRONG: SecureClass = { level: "strong" };

const clipText = (t: string): string => (t.length > TEXT_CAP ? t.slice(0, TEXT_CAP) : t);

/** Distinct ids of an `aria-labelledby` value, read from its first TEXT_CAP characters. */
function labelledByIds(refs: string): Set<string> {
  const ids = new Set<string>();
  for (const id of clipText(refs).split(/\s+/)) if (id !== "") ids.add(id);
  return ids;
}

/** Value characters a `DomIndex` folds (secret keys, password keys) before it fails closed. */
export const FOLD_BUDGET = 2_000_000;

const hashKeys = (keys: string[]): string =>
  createHash("sha256").update(keys.join("\u0000")).digest("hex").slice(0, 32);

/**
 * A remembered password value: a hash of its scrubber keys (so a long value is bounded and the
 * memory holds no plaintext). Undefined for an empty value.
 */
export function passwordKey(value: string): string | undefined {
  if (value.trim() === "") return undefined;
  return hashKeys(secretKeys(value));
}

/** A value in a `type=password` input: its document (`frameId|origin`), hash and length. */
export interface PasswordEntry {
  doc: string;
  key: string;
  length: number;
}

/** Password values remembered per document, at most this many (oldest dropped first). */
export const MAX_REMEMBERED = 256;
/** Documents remembered, at most this many (oldest dropped first, never the top one). */
export const MAX_REMEMBERED_DOCS = 16;

/**
 * Values seen in `type=password` inputs, per document (`frameId|origin`), for one tab. A field
 * is checked only against its own document's values, so one frame can neither test guesses
 * against another's password nor evict it. Each document keeps its `MAX_REMEMBERED` newest.
 */
export class PasswordMemory {
  readonly #docs = new Map<string, Map<string, number>>();
  readonly #lengths = new Map<string, Set<number>>();
  #top: string | undefined;

  /** Remember a snapshot's password fields; `top` is the top document's key (never evicted). */
  remember(entries: Iterable<PasswordEntry>, top?: string): void {
    if (top !== undefined) this.#top = top;
    for (const e of entries) {
      let m = this.#docs.get(e.doc);
      if (m === undefined) m = new Map();
      // Most recently seen last.
      this.#docs.delete(e.doc);
      this.#docs.set(e.doc, m);
      m.delete(e.key);
      m.set(e.key, e.length);
      for (const k of m.keys()) {
        if (m.size <= MAX_REMEMBERED) break;
        m.delete(k);
      }
      this.#lengths.delete(e.doc);
      for (const d of this.#docs.keys()) {
        if (this.#docs.size <= MAX_REMEMBERED_DOCS) break;
        if (d === this.#top || d === e.doc) continue;
        this.#docs.delete(d);
        this.#lengths.delete(d);
      }
    }
  }

  /** Some value of this length is remembered for the document (checked before hashing). */
  hasLength(doc: string, length: number): boolean {
    let set = this.#lengths.get(doc);
    if (set === undefined) {
      set = new Set(this.#docs.get(doc)?.values() ?? []);
      this.#lengths.set(doc, set);
    }
    return set.has(length);
  }

  has(doc: string, key: string): boolean {
    return this.#docs.get(doc)?.has(key) === true;
  }

  /** Values remembered, in all documents. */
  get size(): number {
    let n = 0;
    for (const m of this.#docs.values()) n += m.size;
    return n;
  }

  /** Values remembered for one document. */
  sizeOf(doc: string): number {
    return this.#docs.get(doc)?.size ?? 0;
  }

  clear(): void {
    this.#docs.clear();
    this.#lengths.clear();
    this.#top = undefined;
  }
}

/** Remember the page's password fields in `memory` (the top document is never evicted). */
export function rememberPasswords(memory: PasswordMemory, dom: DomIndex): void {
  memory.remember(dom.passwordFields(), dom.docKey(0));
}

function isField(info: DomNodeInfo): boolean {
  return (
    info.tag === "INPUT" ||
    info.tag === "TEXTAREA" ||
    (info.attrs.contenteditable !== undefined && info.attrs.contenteditable !== "false")
  );
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
  // Clipped like every label (a hostile page's 1 MB `name` must not cost 1 MB per rule).
  const c = (t: string | undefined) => (t === undefined ? undefined : clipText(t));
  return isMoneyPaymentField({
    autocomplete: c(attrs.autocomplete),
    name: c(attrs.name),
    id: c(attrs.id),
    placeholder: c(attrs.placeholder),
    label: c(attrs["aria-label"]),
  });
}
