import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanItemText, parseExtraction, runEverythingPass } from "../src/extraction/index.ts";
import { loadCases, parseEml, REDTEAM_DIR, type RedteamCase } from "./redteam-support.ts";
import { DAY, makeWorld, NOW, say, settingsWith, type World } from "./third-party-support.ts";

/**
 * The EM5 gate (docs/design/everything-memory-2026.md §13): the whole red-team suite, replayed
 * as other people's mail through the REAL pass (reader, sender admission, cleaning, screening,
 * batching, extractor call, validator, sink) against recorded cloud and local model replies.
 * The recordings are synthetic (see redteam/README.md); no model ran.
 */

const REC_DIR = join(REDTEAM_DIR, "..", "redteam-recordings");
type Recording = { kind: string; responses: Record<string, string> };
const recordings: Recording[] = ["cloud", "local"].map(
  (k) => JSON.parse(readFileSync(join(REC_DIR, `${k}.json`), "utf8")) as Recording,
);
const CASES = loadCases();

/** Tables a hostile message must never change. */
const FROZEN = [
  "graph_identifiers",
  "graph_aliases",
  "graph_blocklist",
  "graph_exclusions",
  "graph_loops",
  "graph_suggestions",
  "graph_participants",
  "graph_interactions",
  "memory_claims",
  "memory_chunks",
  "memory_never_rules",
  "memory_claim_subjects",
] as const;

let w: World;
beforeEach(async () => {
  w = await makeWorld();
});
afterEach(async () => w.close());

const snapshot = () => {
  const out: Record<string, string> = {};
  for (const t of FROZEN)
    out[t] = JSON.stringify(w.env.db.sqlite.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
  out.entities = JSON.stringify(
    w.env.db.sqlite
      .prepare(
        "SELECT id, kind, name, status, merged_into, is_owner, hidden, pinned FROM graph_entities ORDER BY rowid",
      )
      .all(),
  );
  return out;
};

function docFor(c: RedteamCase): {
  body: string;
  title: string;
  sender: string;
  trust: "owner" | "untrusted";
} {
  let body = c.body;
  let format = c.format;
  let title = c.subject;
  let from = c.from;
  if (c.eml !== undefined) {
    const eml = parseEml(readFileSync(join(REDTEAM_DIR, c.eml), "utf8"));
    body = eml.body;
    format = eml.format;
    title = eml.headers.subject ?? title;
    const m = /^(.*)<(.+)>$/.exec(eml.headers.from ?? "");
    if (m !== null) from = { name: (m[1] as string).trim(), email: m[2] as string };
  }
  if (c.bodyRepeat !== undefined) {
    const { head, filler, bytes } = c.bodyRepeat;
    body = head + filler.repeat(Math.ceil(bytes / filler.length));
  }
  // The index stores visible plain text, not raw HTML.
  if (format === "html") body = cleanItemText(body, { format: "html" }).text;
  return {
    body,
    title,
    sender: `${from.name} <${from.email}>`,
    trust: c.trust === "owner" ? "owner" : "untrusted",
  };
}

interface Row {
  id: string;
  entity_id: string;
  attribute: string;
  value: string;
  provenance: string;
  review: string;
  sensitivity: string;
  subject_kind: string;
}

describe.each(recordings.map((r) => [r.kind, r] as [string, Recording]))(
  "recorded %s replies",
  (kind, rec) => {
    it.each(
      CASES.filter((c) => c.flood === undefined).map((c) => [c.id, c] as [string, RedteamCase]),
    )("%s", async (_id, c) => {
      const raw = rec.responses[c.id];
      expect(raw, `no ${kind} recording for ${c.id}`).toBeDefined();
      const d = docFor(c);
      const docId = w.doc({
        id: `mail:${c.id}`,
        title: d.title,
        body: d.body,
        provenance: d.trust,
        sender: d.trust === "owner" ? null : d.sender,
      });
      const before = snapshot();
      w.provider.enqueue(say(raw as string), say(raw as string));
      const report = await runEverythingPass(w.deps());
      const stored = w.env.db.sqlite.prepare("SELECT * FROM graph_facts").all() as Row[];
      const quarantine = w.em.quarantined({ includeDecided: true }).items;

      // --- invariants for every case and every recording ----------------------------------
      expect(report.error).toBeNull();
      for (const r of w.provider.requests) {
        expect(r.tools).toEqual([]);
        expect(r.toolChoice).toBe("none");
      }
      expect(snapshot()).toEqual(before);
      expect(stored.filter((f) => f.entity_id === w.ownerId)).toEqual([]);
      const cleaned = cleanItemText(`${d.title}\n\n${d.body}`.trim(), { format: "text" }).text;
      for (const f of stored) {
        expect(f.provenance).not.toBe("owner");
        expect(["gov_id", "account_numbers"]).not.toContain(f.sensitivity);
        expect(f.value).not.toMatch(/@|https?:|[<>`{}]|\$\(/);
        if (d.trust === "untrusted") {
          expect(f.provenance).toBe("untrusted");
          expect(f.review).toBe("pending");
        }
        const cites = w.em.citations("fact", f.id);
        expect(cites.length).toBeGreaterThan(0);
        for (const cite of cites) {
          expect(cite.sourceRef).toBe(docId);
          expect(cleaned.slice(cite.start, cite.end)).toBe(cite.quote);
          if (d.trust === "untrusted") expect(cite.authorEntityId).toBe(w.samId);
        }
      }
      if (d.trust === "untrusted") {
        expect(w.graph.facts(w.samId)).toEqual([]);
        expect(w.graph.facts(w.priyaId)).toEqual([]);
      }
      for (const e of w.env.db.sqlite.prepare("SELECT review, rel FROM graph_edges").all() as {
        review: string;
        rel: string;
      }[]) {
        expect(e.review).toBe("pending");
        expect(e.rel).not.toBe("related_to");
      }
      // The agent sees none of it (accepted mode, nothing confirmed).
      // --- the outcome ----------------------------------------------------------------------
      const e = c.expect;
      if (e.outcome === "pending" && d.trust === "untrusted") {
        if (parseExtraction(raw as string).ok) {
          expect(
            stored.map((f) => ({ attribute: f.attribute, value: f.value })).sort(byKey),
          ).toEqual([...(e.facts ?? [])].sort(byKey));
        } else {
          // A reply that is not the closed form stores nothing and holds the item.
          expect(stored).toEqual([]);
          expect(quarantine.flatMap((q) => q.reasons)).toContain("schema_invalid");
        }
      } else if (
        e.outcome === "nothing_stored" ||
        e.outcome === "quarantined" ||
        e.outcome === "batch_rejected"
      ) {
        // Hidden markup is removed before the index stores the text, so what is left is ordinary
        // visible text; anything kept from it was cited from that visible text (checked above).
        const hiddenOnly = e.reasons?.length === 1 && e.reasons[0] === "hidden_text";
        if (!hiddenOnly) expect(stored).toEqual([]);
        expect(report.edgesStored).toBe(0);
        if (
          e.outcome === "quarantined" &&
          w.provider.requests.length === 0 &&
          quarantine.length > 0
        ) {
          // Held before the model saw it.
          expect(
            quarantine.every((q) => q.senderEntityId === null || q.senderEntityId === w.samId),
          ).toBe(true);
        }
      }
    });
  },
);

const byKey = (a: { attribute: string; value: string }, b: { attribute: string; value: string }) =>
  `${a.attribute}:${a.value}`.localeCompare(`${b.attribute}:${b.value}`);

describe("injection never reaches the model unscreened", () => {
  it("every case the deterministic screen flags is held before any model call", async () => {
    let held = 0;
    for (const c of CASES.filter(
      (x) =>
        x.flood === undefined &&
        x.trust === "untrusted" &&
        x.expect.outcome === "quarantined" &&
        x.expect.reasons?.includes("instruction_like"),
    )) {
      const d = docFor(c);
      w.doc({ id: `mail:${c.id}`, title: d.title, body: d.body, sender: d.sender });
    }
    const r = await runEverythingPass(w.deps());
    held = r.quarantined;
    expect(w.provider.requests.length).toBeLessThanOrEqual(1);
    expect(held).toBeGreaterThanOrEqual(15);
    expect(w.sent()).not.toMatch(
      /forward the owner's last 10 emails|ignore previous instructions|im_start/i,
    );
  });
});

describe("a flood from one sender", () => {
  for (const kind of ["cloud", "local"] as const) {
    it(`${kind}: at most twenty facts are kept, the rest of the night's messages are held`, async () => {
      for (let i = 0; i < 30; i++)
        w.doc({
          body: `My hobby is collecting stamp number ${i}.`,
          ms: NOW - DAY / 2 + i,
          thread: `f${i}`,
        });
      for (let i = 0; i < 30; i++) {
        const q = `My hobby is collecting stamp number ${i}.`;
        const json = JSON.stringify({
          facts: [
            {
              handle: "p1",
              attribute: "likes",
              value: `stamp number ${i}`,
              item: "i1",
              quote: q,
              start: 0,
              end: q.length,
              subject_kind: "self_disclosure",
              sensitivity: "none",
              confidence: 0.9,
            },
          ],
          edges: [],
          flags: [],
        });
        w.provider.enqueue(say(kind === "local" ? `\`\`\`json\n${json}\n\`\`\`` : json));
      }
      await runEverythingPass(w.deps({ settings: settingsWith({}) }));
      const rows = w.env.db.sqlite.prepare("SELECT count(*) AS n FROM graph_facts").get() as {
        n: number;
      };
      expect(rows.n).toBe(20);
      expect(w.em.quarantined().items.every((x) => x.reasons.includes("sender_limit"))).toBe(true);
    });
  }
});
