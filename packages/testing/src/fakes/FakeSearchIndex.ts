import type {
  SearchIndex,
  SearchIndexDoc,
  SearchIndexHit,
  SearchIndexQuery,
  SearchIndexResult,
} from "@psyche/protocol";

function terms(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Term-overlap index: title hits weigh double; ties broken by recency. Incognito never returned. */
export class FakeSearchIndex implements SearchIndex {
  #docs = new Map<string, SearchIndexDoc>();

  async index(doc: SearchIndexDoc): Promise<void> {
    this.#docs.set(doc.id, structuredClone(doc));
  }

  async remove(id: string): Promise<void> {
    this.#docs.delete(id);
  }

  async query(query: SearchIndexQuery): Promise<SearchIndexResult> {
    const q = terms(query.q);
    const f = query.filters ?? {};
    const hits: (SearchIndexHit & { at: number })[] = [];
    for (const d of this.#docs.values()) {
      if (d.incognito === true) continue;
      if (f.kinds !== undefined && !f.kinds.includes(d.kind)) continue;
      if (f.provenance !== undefined && !f.provenance.includes(d.provenance)) continue;
      if (f.from !== undefined && d.from !== f.from) continue;
      if (f.threadId !== undefined && d.threadId !== f.threadId) continue;
      if (f.before !== undefined && d.createdAt >= f.before) continue;
      if (f.after !== undefined && d.createdAt <= f.after) continue;
      const title = terms(d.title);
      const body = terms(d.text);
      let score = 0;
      for (const t of q) {
        score += title.filter((x) => x === t).length * 2 + body.filter((x) => x === t).length;
      }
      if (q.length > 0 && score === 0) continue;
      const first = q.length === 0 ? -1 : d.text.toLowerCase().indexOf(q[0] ?? "");
      const snippet =
        first < 0 ? d.text.slice(0, 120) : d.text.slice(Math.max(0, first - 40), first + 80);
      hits.push({
        id: d.id,
        kind: d.kind,
        title: d.title,
        score,
        snippet,
        provenance: d.provenance,
        at: d.updatedAt ?? d.createdAt,
      });
    }
    hits.sort((a, b) => b.score - a.score || b.at - a.at);
    const limited = hits.slice(0, query.limit ?? 20).map(({ at: _at, ...h }) => h);
    return { hits: limited, total: hits.length };
  }
}
