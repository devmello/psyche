import { PsycheError } from "@psyche/protocol";
import type { ElementMeta } from "../types.ts";

export interface RefEntry {
  ref: string;
  backendNodeId: number;
  documentKey: string;
  meta: ElementMeta;
}

/**
 * Per-tab ref registry. Refs are keyed by `backendDOMNodeId` within one document, so the same
 * element keeps its `ref_N` across snapshots of that document (spike 01: byte-identical refs).
 * The counter is monotonic for the life of the tab and refs are never reassigned: after a
 * navigation an old ref is `stale`, never silently pointing at a new element (spike 04,
 * incident 1).
 */
export class RefRegistry {
  #next = 1;
  #document = "";
  #byKey = new Map<string, string>();
  #byRef = new Map<string, RefEntry>();
  /** Refs of earlier documents, kept only to tell "stale" from "unknown". */
  #stale = new Set<string>();
  #staleCap: number;

  constructor(options: { staleCap?: number } = {}) {
    this.#staleCap = options.staleCap ?? 5000;
  }

  get documentKey(): string {
    return this.#document;
  }

  /** Switch to a new document: every live ref becomes stale. */
  setDocument(key: string): void {
    if (key === this.#document) return;
    for (const ref of this.#byRef.keys()) this.#stale.add(ref);
    if (this.#stale.size > this.#staleCap) {
      const drop = this.#stale.size - this.#staleCap;
      let i = 0;
      for (const r of this.#stale) {
        if (i++ >= drop) break;
        this.#stale.delete(r);
      }
    }
    this.#byKey.clear();
    this.#byRef.clear();
    this.#document = key;
  }

  /** Mark every ref stale without changing documents (after Take control, refs must be re-read). */
  invalidate(): void {
    const doc = this.#document;
    this.#document = "";
    this.setDocument(doc);
  }

  refFor(backendNodeId: number, meta: Omit<ElementMeta, "ref">): string {
    const key = `${this.#document}#${backendNodeId}`;
    let ref = this.#byKey.get(key);
    if (ref === undefined) {
      ref = `ref_${this.#next++}`;
      this.#byKey.set(key, ref);
    }
    this.#byRef.set(ref, {
      ref,
      backendNodeId,
      documentKey: this.#document,
      meta: { ...meta, ref },
    });
    return ref;
  }

  has(ref: string): boolean {
    return this.#byRef.has(ref);
  }

  /** Resolve a ref of the current document; `not_found` with `details.reason` otherwise. */
  resolve(ref: string): RefEntry {
    const e = this.#byRef.get(ref);
    if (e !== undefined) return e;
    if (this.#stale.has(ref)) {
      throw new PsycheError(
        "not_found",
        `${ref} belongs to an earlier page state; take a new snapshot`,
        {
          details: { reason: "stale_ref", ref },
        },
      );
    }
    throw new PsycheError("not_found", `${ref} is not in the current snapshot`, {
      details: { reason: "unknown_ref", ref },
    });
  }

  get size(): number {
    return this.#byRef.size;
  }
}
