import type { GraphEntityKind } from "@psyche/protocol";
import { normalizeName } from "./normalize.ts";
import type { GraphStore } from "./store.ts";

/**
 * The in-memory name index behind entity recall: normalised name or alias -> entities. It is built
 * from one batch read and rebuilt when the store's entity version moves (entity create, rename,
 * alias, delete and merge all emit an entity event or write an alias), so a turn never queries
 * the database per entity. Matching is a word n-gram lookup of the owner's text against the map.
 */
export const RECALL_KINDS: GraphEntityKind[] = ["person", "org", "project"];
const MIN_NAME = 3;
const MAX_WORDS = 6;

interface Slot {
  id: string;
  kind: GraphEntityKind;
  /** Position in the stored order (sort name), so matches keep the order the old scan had. */
  order: number;
  name: string;
}

export class EntityNameIndex {
  readonly version: number;
  /** Normalised name or alias -> entities that answer to it. */
  readonly #byName = new Map<string, Set<string>>();
  /** Kind and normalised primary name -> entities (the ambiguity check). */
  readonly #byPrimary = new Map<string, Set<string>>();
  readonly #slots = new Map<string, Slot>();
  #maxWords = 1;

  constructor(graph: GraphStore) {
    this.version = graph.entityVersion();
    let order = 0;
    for (const row of graph.nameIndexRows(RECALL_KINDS)) {
      this.#slots.set(row.id, { id: row.id, kind: row.kind, order: order++, name: row.name });
      this.#add(this.#byPrimary, `${row.kind}|${normalizeName(row.name)}`, row.id);
      for (const n of [row.name, ...row.aliases].map(normalizeName)) {
        if (n.length < MIN_NAME) continue;
        this.#add(this.#byName, n, row.id);
        this.#maxWords = Math.max(this.#maxWords, Math.min(MAX_WORDS, n.split(" ").length));
      }
    }
  }

  #add(map: Map<string, Set<string>>, key: string, id: string): void {
    const set = map.get(key);
    if (set === undefined) map.set(key, new Set([id]));
    else set.add(id);
  }

  get size(): number {
    return this.#slots.size;
  }

  /** Another entity of the same kind has this entity's name. */
  ambiguous(id: string): boolean {
    const slot = this.#slots.get(id);
    if (slot === undefined) return false;
    return (this.#byPrimary.get(`${slot.kind}|${normalizeName(slot.name)}`)?.size ?? 0) > 1;
  }

  /**
   * Entities whose name or alias appears as whole words in `normalizedText`, each with the
   * longest name that matched, in stored order.
   */
  match(normalizedText: string): { id: string; said: string }[] {
    const words = normalizedText.split(" ").filter((w) => w.length > 0);
    const best = new Map<string, string>();
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= this.#maxWords && i + n <= words.length; n++) {
        const gram = words.slice(i, i + n).join(" ");
        const ids = this.#byName.get(gram);
        if (ids === undefined) continue;
        for (const id of ids) {
          const prev = best.get(id);
          if (prev === undefined || gram.length > prev.length) best.set(id, gram);
        }
      }
    }
    return [...best]
      .map(([id, said]) => ({ id, said, order: this.#slots.get(id)?.order ?? 0 }))
      .sort((a, b) => a.order - b.order)
      .map(({ id, said }) => ({ id, said }));
  }
}

const cache = new WeakMap<GraphStore, EntityNameIndex>();

/** The current index for a store: built on first use, rebuilt only after an entity change. */
export function entityNameIndex(graph: GraphStore): EntityNameIndex {
  const hit = cache.get(graph);
  if (hit !== undefined && hit.version === graph.entityVersion()) return hit;
  const built = new EntityNameIndex(graph);
  cache.set(graph, built);
  return built;
}
