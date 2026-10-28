import type {
  EverythingSensitiveClass,
  GraphCitationSource,
  GraphFactAttribute,
  GraphSensitivity,
  QuarantineReason,
} from "@psyche/protocol";
import { detectSensitive, looksLikeInstruction } from "../filters.ts";
import { type CitationInput, isSingleValued } from "../graph/everything.ts";
import { OWNER_ONLY_RELS } from "../graph/store.ts";
import type { ExtractionEdge, ExtractionFact, ExtractionOutput } from "./schema.ts";
import { screenItem } from "./screen.ts";
import { classifySensitivity, stricterSensitivity } from "./sensitivity.ts";
import type { ExtractionSink } from "./sink.ts";

/**
 * Stage 3 of the extraction pipeline (docs/design/everything-memory-2026.md §5.1): the model's
 * output is untrusted data, and this code decides everything. Nothing here calls a model, a tool
 * or the network; the only way out is the `ExtractionSink`.
 *
 * Checks, in order, per fact: item and subject handles resolve; the subject belongs to the item
 * (subject binding); the kind matches the item's trust; the value is short, plain and not an
 * identifier or an instruction; the quote is really in the item's cleaned text and supports the
 * value (citation); the sensitivity class is the stricter of model and rules and its switch is
 * on (hard-blocked classes never); then the limits. An item that trips a quarantine rule is held
 * back whole and nothing from it is stored.
 */

export const MAX_FACTS_PER_ITEM = 5;
export const MAX_FACTS_PER_SENDER_PER_NIGHT = 20;
/** Most distinct values for one single attribute of one person proposed in a night (original + one contradiction). */
export const MAX_VALUES_PER_ATTRIBUTE_PER_NIGHT = 2;
export const MAX_VALUE_CHARS = 200;
export const MAX_QUOTE_CHARS = 200;
/** A sender first seen this recently who yields a sensitive fact is quarantined (§5.6). */
export const NEW_SENDER_DAYS = 7;

export interface BatchItem {
  /** Opaque handle the model saw (`i1`). */
  handle: string;
  source: GraphCitationSource;
  sourceRef: string;
  /** `owner`: the owner wrote it; `trusted`: an owner-declared folder or calendar (#1006); `untrusted`: anyone else. */
  trust: "owner" | "trusted" | "untrusted";
  /** Handle of the author (`p1`); the owner's handle for owner-authored items. */
  authorHandle: string;
  participantHandles: string[];
  /** People named in the text (not senders or recipients). */
  mentionHandles: string[];
  /** Cleaned text: the reference every citation is checked against. */
  text: string;
  sourceHash: string;
  docId?: string | null;
  observedAt?: string;
  /** Reasons the reader's own screen already found (so the model never saw the item). */
  screenReasons?: QuarantineReason[];
  /** The raw text had hidden content removed while cleaning. */
  hiddenRemoved?: boolean;
  rawLength?: number;
  visibleLength?: number;
  /** Extra untrusted fields (subject, display name, signature) to screen. */
  fields?: string[];
}

export interface BatchCandidate {
  handle: string;
  entityId: string;
  isOwner: boolean;
  /** When this person was first seen; absent means long known. */
  firstSeenAt?: string;
}

export interface ValidationSettings {
  /** Which sensitive classes the owner switched on. All off by default. */
  sensitive: Partial<Record<EverythingSensitiveClass, boolean>>;
  /** Facts one person's text asserts about someone else; off until EM5. */
  allowAboutOther: boolean;
  /** Auto-accept non-sensitive facts from owner-authored items (confidence >= 0.8). */
  autoAcceptOwnerAuthored: boolean;
}

export const DEFAULT_VALIDATION_SETTINGS: ValidationSettings = {
  sensitive: {},
  allowAboutOther: false,
  autoAcceptOwnerAuthored: true,
};

/** Counters that span batches in one night. */
export interface NightLimits {
  perSender: Map<string, number>;
  /** `entity|attribute` -> distinct normalized values proposed. */
  perAttribute: Map<string, Set<string>>;
}

export function newNightLimits(): NightLimits {
  return { perSender: new Map(), perAttribute: new Map() };
}

export interface OwnerProposal {
  attribute: GraphFactAttribute;
  value: string;
  citation: CitationInput;
}

export interface ValidationReport {
  factsStored: number;
  edgesStored: number;
  /** Counts by reason; never text. Safe to put in the run log. */
  dropped: Record<string, number>;
  /** `source:sourceRef` of items sent to quarantine. */
  quarantined: string[];
  /** Facts about the owner from owner-authored text: proposals for USER.md, never graph facts. */
  ownerProposals: OwnerProposal[];
}

export interface ValidateInput {
  output: ExtractionOutput;
  items: BatchItem[];
  candidates: BatchCandidate[];
  sink: ExtractionSink;
  settings?: ValidationSettings;
  limits?: NightLimits;
  now?: number;
}

const HARD_BLOCKED = new Set<GraphSensitivity>(["gov_id", "account_numbers"]);

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

/** `[start, end)` of `quote` in `source`: exact, else ignoring case and whitespace. */
export function locateQuote(source: string, quote: string): [number, number] | undefined {
  const q = quote.trim();
  if (q.length === 0) return undefined;
  const exact = source.indexOf(q);
  if (exact >= 0) return [exact, exact + q.length];
  const parts = q.split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  try {
    const m = new RegExp(parts.join("\\s+"), "iu").exec(source);
    return m === null ? undefined : [m.index, m.index + m[0].length];
  } catch {
    return undefined;
  }
}

/** The value is made of what the quote says: numbers exactly, and half the words at least. */
export function valueSupportedByQuote(value: string, quote: string): boolean {
  const q = norm(quote);
  const digits = norm(value).match(/\d+/g) ?? [];
  if (digits.some((d) => !q.includes(d))) return false;
  const words = (norm(value).match(/\p{L}{2,}/gu) ?? []).filter((w) => w.length >= 2);
  if (words.length === 0) return digits.length > 0;
  const hits = words.filter((w) => q.includes(w.slice(0, Math.max(3, w.length - 2)))).length;
  return hits >= Math.ceil(words.length / 2);
}

/** What a value must never contain: an identifier, a link, markup or code. */
function valueProblem(value: string): string | undefined {
  if (value.length > MAX_VALUE_CHARS) return "value_too_long";
  if (/[\r\n]/.test(value)) return "value_multiline";
  if (
    /https?:\/\/|www\.|\b[\w.+-]+\.(?:com|org|net|io|co|ai|dev|app|ru|cn|xyz|top)\b/i.test(value)
  ) {
    return "link_in_value";
  }
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(value) || /(?:^|\s)@[\w.]{2,}/.test(value)) {
    return "identifier_in_value";
  }
  // A phone number: a run of 7+ digits with common separators.
  if (/(?:\+?\d[\s().-]?){7,}/.test(value) && (value.match(/\d/g) ?? []).length >= 7) {
    return "identifier_in_value";
  }
  if (/[<>{}`]|```|\$\(|\\u[0-9a-f]{4}/i.test(value)) return "markup_in_value";
  if (looksLikeInstruction(value)) return "instruction_like";
  if (detectSensitive(value).some((k) => k !== "health")) return "secret_in_value";
  return undefined;
}

function quoteProblem(quote: string): string | undefined {
  const t = quote.trim();
  if (t.length < 3) return "quote_too_short";
  if (t.length > MAX_QUOTE_CHARS) return "quote_too_long";
  if (looksLikeInstruction(t) || screenItem({ text: t, trust: "untrusted" }).reasons.length > 0) {
    return "instruction_like_quote";
  }
  return undefined;
}

export function validateExtraction(input: ValidateInput): ValidationReport {
  const settings = input.settings ?? DEFAULT_VALIDATION_SETTINGS;
  const limits = input.limits ?? newNightLimits();
  const now = input.now ?? Date.now();
  const report: ValidationReport = {
    factsStored: 0,
    edgesStored: 0,
    dropped: {},
    quarantined: [],
    ownerProposals: [],
  };
  const drop = (reason: string, n = 1) => {
    report.dropped[reason] = (report.dropped[reason] ?? 0) + n;
  };
  const items = new Map(input.items.map((i) => [i.handle, i]));
  const people = new Map(input.candidates.map((c) => [c.handle, c]));

  // 1. Per-item verdict: deterministic screen, reader flags, model flags.
  const reasonsByItem = new Map<string, Set<QuarantineReason>>();
  const addReason = (handle: string, reason: QuarantineReason) => {
    const set = reasonsByItem.get(handle) ?? new Set<QuarantineReason>();
    reasonsByItem.set(handle, set);
    set.add(reason);
  };
  for (const item of input.items) {
    for (const r of item.screenReasons ?? []) addReason(item.handle, r);
    for (const r of screenItem({
      text: item.text,
      trust: item.trust,
      ...(item.hiddenRemoved === undefined ? {} : { hiddenRemoved: item.hiddenRemoved }),
      ...(item.rawLength === undefined ? {} : { rawLength: item.rawLength }),
      ...(item.visibleLength === undefined ? {} : { visibleLength: item.visibleLength }),
      ...(item.fields === undefined ? {} : { fields: item.fields }),
    }).reasons) {
      addReason(item.handle, r);
    }
  }
  for (const flag of input.output.flags) {
    const item = items.get(flag.item);
    if (item === undefined) {
      drop("unknown_item");
      continue;
    }
    if (flag.instruction_like) addReason(item.handle, "instruction_like");
    if (item.trust === "untrusted") {
      if (flag.about_owner) addReason(item.handle, "claims_about_owner");
      if (flag.identity_claim) addReason(item.handle, "identity_claim");
    }
  }

  // 2. Group claims by item and count the raw volume before dropping anything.
  const factsByItem = new Map<string, ExtractionFact[]>();
  const edgesByItem = new Map<string, ExtractionEdge[]>();
  for (const f of input.output.facts) {
    if (!items.has(f.item)) {
      drop("unknown_item");
      continue;
    }
    const list = factsByItem.get(f.item) ?? [];
    list.push(f);
    factsByItem.set(f.item, list);
  }
  for (const e of input.output.edges) {
    if (!items.has(e.item)) {
      drop("unknown_item");
      continue;
    }
    const list = edgesByItem.get(e.item) ?? [];
    list.push(e);
    edgesByItem.set(e.item, list);
  }
  for (const item of input.items) {
    const raw =
      (factsByItem.get(item.handle)?.length ?? 0) + (edgesByItem.get(item.handle)?.length ?? 0);
    if (raw > MAX_FACTS_PER_ITEM) addReason(item.handle, "too_many_claims");
  }

  // 3. Validate each remaining item; quarantine whole items, store the rest.
  for (const item of input.items) {
    const author = people.get(item.authorHandle);
    const quarantineItem = (reasons: Iterable<QuarantineReason>) => {
      const list = [...new Set(reasons)];
      input.sink.quarantine({
        source: item.source,
        sourceRef: item.sourceRef,
        senderEntityId: author === undefined || author.isOwner ? null : author.entityId,
        reasons: list,
        excerpt: item.text.slice(0, 300),
      });
      report.quarantined.push(`${item.source}:${item.sourceRef}`);
      const claims =
        (factsByItem.get(item.handle)?.length ?? 0) + (edgesByItem.get(item.handle)?.length ?? 0);
      if (claims > 0) drop("item_quarantined", claims);
    };
    const flagged = reasonsByItem.get(item.handle);
    if (flagged !== undefined && flagged.size > 0) {
      quarantineItem(flagged);
      continue;
    }
    const facts = factsByItem.get(item.handle) ?? [];
    const edges = edgesByItem.get(item.handle) ?? [];
    if (facts.length + edges.length === 0) continue;

    const pending: (() => void)[] = [];
    const itemReasons = new Set<QuarantineReason>();
    let sensitiveKept = false;
    const reach = new Set([item.authorHandle, ...item.participantHandles, ...item.mentionHandles]);

    for (const f of facts) {
      const subject = people.get(f.handle);
      if (subject === undefined) {
        drop("unknown_subject");
        continue;
      }
      if (!reach.has(f.handle)) {
        drop("subject_not_in_item");
        continue;
      }
      const authorIsSubject = f.handle === item.authorHandle;
      if (item.trust === "untrusted") {
        if (subject.isOwner) {
          // Anything a third party says about the owner is read-only quarantine, never a fact.
          itemReasons.add("claims_about_owner");
          continue;
        }
        if (f.subject_kind === "owner_stated") {
          drop("kind_mismatch");
          continue;
        }
        if (f.subject_kind === "self_disclosure" && !authorIsSubject) {
          // The model says "the sender about themselves" about someone else: a binding break.
          drop("subject_mismatch");
          itemReasons.add("identity_claim");
          continue;
        }
        if (f.subject_kind === "about_other" && authorIsSubject) {
          drop("kind_mismatch");
          continue;
        }
        if (f.subject_kind === "about_other" && !settings.allowAboutOther) {
          drop("about_other_disabled");
          continue;
        }
      } else if (f.subject_kind !== "owner_stated") {
        drop("kind_mismatch");
        continue;
      }
      const vp = valueProblem(f.value);
      if (vp !== undefined) {
        drop(vp);
        continue;
      }
      const qp = quoteProblem(f.quote);
      if (qp !== undefined) {
        drop(qp);
        continue;
      }
      const span = locateQuote(item.text, f.quote);
      if (span === undefined) {
        drop("quote_not_found");
        continue;
      }
      const located = item.text.slice(span[0], span[1]);
      if (located.length > MAX_QUOTE_CHARS) {
        drop("quote_too_long");
        continue;
      }
      if (!valueSupportedByQuote(f.value, located)) {
        drop("value_not_in_quote");
        continue;
      }
      const cls = stricterSensitivity(
        f.sensitivity,
        classifySensitivity(`${f.value} ${located}`, f.attribute),
      );
      if (HARD_BLOCKED.has(cls)) {
        drop(`blocked:${cls}`);
        continue;
      }
      if (cls !== "none") {
        if (settings.sensitive[cls as EverythingSensitiveClass] !== true) {
          drop(`sensitive_off:${cls}`);
          continue;
        }
        if (f.derived === true) {
          drop("sensitive_derived");
          continue;
        }
        sensitiveKept = true;
      }
      const value = f.value.replace(/\s+/g, " ").trim();
      if (subject.isOwner) {
        // From the owner's own text: a USER.md proposal, not a graph fact (§4.3).
        report.ownerProposals.push({
          attribute: f.attribute,
          value,
          citation: citation(item, span, located, subject.entityId, now),
        });
        continue;
      }
      if (isSingleValued(f.attribute)) {
        const key = `${subject.entityId}|${f.attribute}`;
        const seen = limits.perAttribute.get(key) ?? new Set<string>();
        seen.add(norm(value));
        if (seen.size > MAX_VALUES_PER_ATTRIBUTE_PER_NIGHT) {
          drop("conflict_limit");
          continue;
        }
        limits.perAttribute.set(key, seen);
      }
      const auto =
        settings.autoAcceptOwnerAuthored &&
        item.trust !== "untrusted" &&
        cls === "none" &&
        f.confidence >= 0.8;
      pending.push(() => {
        const out = input.sink.proposeFact({
          entityId: subject.entityId,
          attribute: f.attribute,
          value,
          provenance: item.trust === "untrusted" ? "untrusted" : "agent",
          subjectKind: item.trust === "untrusted" ? f.subject_kind : "owner_stated",
          sensitivity: cls,
          confidence: f.confidence,
          citations: [citation(item, span, located, author?.entityId ?? null, now)],
          autoAccept: auto,
        });
        if (out.status === "refused") drop(`store:${out.reason}`);
        else report.factsStored++;
      });
    }

    for (const e of edges) {
      const src = people.get(e.src);
      const dst = people.get(e.dst);
      if (src === undefined || dst === undefined) {
        drop("unknown_subject");
        continue;
      }
      if (!reach.has(e.src) || !reach.has(e.dst)) {
        drop("subject_not_in_item");
        continue;
      }
      if (OWNER_ONLY_RELS.has(e.rel as never)) {
        drop("owner_only_relation");
        continue;
      }
      if (item.trust === "untrusted") {
        const touchesAuthor = e.src === item.authorHandle || e.dst === item.authorHandle;
        if (!touchesAuthor && !settings.allowAboutOther) {
          drop("about_other_disabled");
          continue;
        }
      }
      const qp = quoteProblem(e.quote);
      if (qp !== undefined) {
        drop(qp);
        continue;
      }
      const span = locateQuote(item.text, e.quote);
      if (span === undefined) {
        drop("quote_not_found");
        continue;
      }
      const located = item.text.slice(span[0], span[1]);
      pending.push(() => {
        const out = input.sink.proposeEdge({
          src: src.entityId,
          dst: dst.entityId,
          rel: e.rel,
          ...(e.role === undefined ? {} : { role: e.role }),
          provenance: item.trust === "untrusted" ? "untrusted" : "agent",
          confidence: e.confidence,
          citations: [citation(item, span, located, author?.entityId ?? null, now)],
        });
        if (out.status === "refused") drop(`store:${out.reason}`);
        else report.edgesStored++;
      });
    }

    // Item-level rules that need the whole item.
    if (author !== undefined && !author.isOwner && item.trust === "untrusted") {
      if (sensitiveKept && author.firstSeenAt !== undefined) {
        const age = now - Date.parse(author.firstSeenAt);
        if (age <= NEW_SENDER_DAYS * 86_400_000) itemReasons.add("new_sender_sensitive");
      }
      const used = limits.perSender.get(author.entityId) ?? 0;
      if (used + pending.length > MAX_FACTS_PER_SENDER_PER_NIGHT) itemReasons.add("sender_limit");
    }
    if (itemReasons.size > 0) {
      quarantineItem(itemReasons);
      continue;
    }
    if (author !== undefined && !author.isOwner) {
      limits.perSender.set(
        author.entityId,
        (limits.perSender.get(author.entityId) ?? 0) + pending.length,
      );
    }
    for (const write of pending) write();
  }
  return report;
}

function citation(
  item: BatchItem,
  span: [number, number],
  quote: string,
  authorEntityId: string | null,
  now: number,
): CitationInput {
  return {
    source: item.source,
    sourceRef: item.sourceRef,
    quote,
    start: span[0],
    end: span[1],
    sourceHash: item.sourceHash,
    docId: item.docId ?? null,
    authorEntityId,
    observedAt: item.observedAt ?? new Date(now).toISOString(),
  };
}

/**
 * A batch the model got wrong (not JSON, unknown fields, a tool call). The first failure is
 * retried by the caller; the second quarantines every item in the batch (§5.6), because the same
 * text twice produced output that is not the closed form.
 */
export function rejectBatch(items: BatchItem[], sink: ExtractionSink, failures: number): boolean {
  if (failures < 2) return false;
  for (const item of items) {
    sink.quarantine({
      source: item.source,
      sourceRef: item.sourceRef,
      senderEntityId: null,
      reasons: ["schema_invalid"],
      excerpt: item.text.slice(0, 300),
    });
  }
  return true;
}
