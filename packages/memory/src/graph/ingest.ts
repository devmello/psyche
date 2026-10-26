import type { Clock, GraphIdentifierKind, GraphRelationshipLabel } from "@psyche/protocol";
import {
  FREE_MAIL_DOMAINS,
  isBulkMail,
  isMachineOrRoleAddress,
  type MailHeaders,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from "./normalize.ts";
import type { GraphStore, ParticipantInput } from "./store.ts";

/**
 * The deterministic pass (docs/memory/people-and-projects-2026.md §5.1). Connector-neutral
 * records go in; entities, identifiers, interactions, owner facts from Contacts, merge
 * suggestions and rule-based loops come out. No model, no bodies stored. The Gateway maps each
 * connector (Apple Mail, Gmail, IMAP, Calendar, Contacts, Messages, channels) to these records.
 */

export interface Address {
  email: string;
  name?: string;
}

export interface ContactRecord {
  /** The Contacts card identifier. */
  id: string;
  name: string;
  nickname?: string;
  emails?: string[];
  phones?: string[];
  organization?: string;
  title?: string;
  /** `YYYY-MM-DD` or `--MM-DD`. */
  birthday?: string;
  related?: { name: string; label: string }[];
  /** The owner's own card ("me"). */
  isMe?: boolean;
}

export interface MailRecord {
  source: string;
  messageId: string;
  /** ISO time. */
  date: string;
  from: Address;
  to?: Address[];
  cc?: Address[];
  subject?: string;
  threadKey?: string;
  link?: string;
  headers?: MailHeaders;
  /**
   * First lines of the owner's own sent mail, used transiently for the no-reply rule and never
   * stored. Ignored for received mail.
   */
  ownerSnippet?: string;
  /** The message was deleted at the source. */
  deleted?: boolean;
}

export interface EventRecord {
  source: string;
  id: string;
  start: string;
  title?: string;
  organizer?: Address;
  attendees?: (Address & { resource?: boolean })[];
  link?: string;
  deleted?: boolean;
}

export interface MessageRecord {
  source: string;
  chatId: string;
  /** ISO time of the newest message of that conversation on that day. */
  date: string;
  /** The other participants' handles (phone numbers, emails, `telegram:123` …). */
  handles: { value: string; name?: string }[];
  /** At least one message of the day was the owner's. */
  ownerSpoke: boolean;
  isGroup?: boolean;
  link?: string;
}

/** A note in the owner's notes app (titles only, §5.1 "Notes"). */
export interface NoteRecord {
  source: string;
  id: string;
  title: string;
  /** ISO time of the last change. */
  modifiedAt: string;
  link?: string;
  deleted?: boolean;
}

/**
 * The owner's own words in a chat with Psyche (§5.1 "Chats with Psyche"). `text` is used to find
 * the people and projects named and is never stored.
 */
export interface ChatRecord {
  source: string;
  threadId: string;
  /** ISO time the owner wrote it. */
  date: string;
  text: string;
  link?: string;
}

export interface IngestOptions {
  /** The owner's own addresses and numbers: never people, they decide direction. */
  ownerEmails: string[];
  ownerPhones?: string[];
  defaultCountry?: string;
  clock?: Clock;
  /** Days without a reply before an owner ask becomes a `waiting_on` loop (default 3). */
  noReplyDays?: number;
}

export interface IngestReport {
  created: number;
  interactions: number;
  skipped: number;
  suggestions: number;
  loops: number;
}

interface Candidate {
  names: string[];
  threads: string[];
  ownerSent: boolean;
}

interface ThreadState {
  counterpart: string;
  askedAt: string;
  text: string;
  interactionId: string;
  loopId?: string;
  replied?: boolean;
}

const CANDIDATES_KEY = "candidates:mail";
const THREADS_KEY = "threads:asks";
const MAX_CANDIDATES = 5000;
const DAY_MS = 86_400_000;
const ASK =
  /\?|\b(could you|can you|would you|please (send|share|review|confirm|let me know)|let me know|send me|waiting (for|on) your|when (can|will) you)\b/i;

function emptyReport(): IngestReport {
  return { created: 0, interactions: 0, skipped: 0, suggestions: 0, loops: 0 };
}

const LABELS: Record<string, GraphRelationshipLabel> = {
  spouse: "partner",
  partner: "partner",
  husband: "partner",
  wife: "partner",
  mother: "parent",
  father: "parent",
  parent: "parent",
  mom: "parent",
  dad: "parent",
  child: "child",
  son: "child",
  daughter: "child",
  brother: "sibling",
  sister: "sibling",
  sibling: "sibling",
  friend: "friend",
  manager: "manager",
  assistant: "colleague",
  colleague: "colleague",
};

export class GraphIngester {
  readonly #graph: GraphStore;
  readonly #ownerEmails: Set<string>;
  readonly #ownerPhones: Set<string>;
  readonly #country: string;
  readonly #clock: Clock;
  readonly #noReplyDays: number;

  constructor(graph: GraphStore, options: IngestOptions) {
    this.#graph = graph;
    this.#country = options.defaultCountry ?? "1";
    this.#ownerEmails = new Set(
      options.ownerEmails.map((e) => normalizeEmail(e)).filter((e): e is string => e !== undefined),
    );
    this.#ownerPhones = new Set(
      (options.ownerPhones ?? [])
        .map((p) => normalizePhone(p, this.#country))
        .filter((p): p is string => p !== undefined),
    );
    this.#clock = options.clock ?? { now: () => Date.now() };
    this.#noReplyDays = options.noReplyDays ?? 3;
  }

  #isOwner(email: string): boolean {
    const n = normalizeEmail(email);
    return n !== undefined && this.#ownerEmails.has(n);
  }

  // --- Contacts --------------------------------------------------------------------------------

  /** Contacts are owner-curated: their fields are owner facts, their people always exist. */
  ingestContacts(records: ContactRecord[]): IngestReport {
    const report = emptyReport();
    const byName = new Map<string, string>();
    for (const c of records) {
      const id = this.#upsertContact(c, report);
      if (id !== undefined) byName.set(normalizeName(c.name), id);
    }
    // Related names link only to people who are themselves in Contacts.
    for (const c of records) {
      const self = this.#graph.resolveIdentifier("contact", c.id);
      if (self === undefined) continue;
      for (const r of c.related ?? []) {
        const other = byName.get(normalizeName(r.name));
        const label =
          LABELS[
            r.label
              .toLowerCase()
              .replace(/[_<>!$]/g, "")
              .trim()
          ] ?? "other";
        if (other === undefined || other === self) continue;
        this.#graph.setEdge({
          src: self,
          rel: "related_to",
          dst: other,
          label,
          provenance: "owner",
          sources: [`contact:${c.id}`],
        });
      }
    }
    return report;
  }

  #upsertContact(c: ContactRecord, report: IngestReport): string | undefined {
    if (this.#graph.isBlocked("contact", c.id)) {
      report.skipped++;
      return undefined;
    }
    const identifiers: { kind: GraphIdentifierKind; value: string }[] = [
      { kind: "contact", value: c.id },
    ];
    for (const e of c.emails ?? [])
      if (normalizeEmail(e) !== undefined) identifiers.push({ kind: "email", value: e });
    for (const p of c.phones ?? [])
      if (normalizePhone(p, this.#country) !== undefined)
        identifiers.push({ kind: "phone", value: p });
    if (identifiers.some((i) => i.kind !== "contact" && this.#graph.isBlocked(i.kind, i.value))) {
      report.skipped++;
      return undefined;
    }
    // An existing entity holding any of these identifiers is this contact (deterministic link).
    let id = identifiers
      .map((i) => this.#graph.resolveIdentifier(i.kind, i.value))
      .find((x) => x !== undefined);
    if (id === undefined && c.isMe === true) id = this.#graph.ownerEntity()?.id;
    if (id === undefined) {
      id = this.#graph.createEntity({
        kind: "person",
        name: c.name,
        source: "contacts",
        linkedBy: "rule",
        verified: true,
        ...(c.isMe === true ? { isOwner: true } : {}),
      }).id;
      report.created++;
    }
    for (const i of identifiers) {
      if (this.#graph.resolveIdentifier(i.kind, i.value) === undefined) {
        try {
          this.#graph.linkIdentifier(id, i.kind, i.value, {
            source: "contacts",
            linkedBy: "rule",
            verified: true,
          });
        } catch {
          // owned by another entity: suggest instead of moving it
          const other = this.#graph.resolveIdentifier(i.kind, i.value);
          if (other !== undefined && other !== id) {
            if (
              this.#graph.suggest({
                kind: "merge",
                entityIds: [id, other],
                reason: `Both have ${i.value} (Contacts)`,
              }) !== undefined
            )
              report.suggestions++;
          }
        }
      }
    }
    if (c.nickname !== undefined) this.#graph.addAlias(id, c.nickname, "contacts");
    const sources = [`contact:${c.id}`];
    if (
      c.title !== undefined &&
      c.title.trim().length > 0 &&
      !this.#graph.isRejectedFact(id, "title", c.title)
    ) {
      this.#graph.setFact({
        entityId: id,
        attribute: "title",
        value: c.title,
        provenance: "owner",
        sources,
      });
    }
    if (
      c.birthday !== undefined &&
      /^(\d{4}|-)-?\d{2}-\d{2}$/.test(c.birthday) &&
      !this.#graph.isRejectedFact(id, "birthday", c.birthday)
    ) {
      this.#graph.setFact({
        entityId: id,
        attribute: "birthday",
        value: c.birthday,
        provenance: "owner",
        sources,
      });
    }
    if (c.organization !== undefined && c.organization.trim().length > 0) {
      const org = this.#org(c.organization, c.emails ?? []);
      if (org !== undefined)
        this.#graph.setEdge({ src: id, rel: "works_at", dst: org, provenance: "owner", sources });
    }
    return id;
  }

  /** Finds or creates an organisation by its domain (never a free-mail one) or exact name. */
  #org(name: string, emails: string[]): string | undefined {
    const domain = emails
      .map((e) => normalizeEmail(e)?.split("@")[1])
      .find((d): d is string => d !== undefined && !FREE_MAIL_DOMAINS.has(d));
    if (domain !== undefined) {
      const byDomain = this.#graph.resolveIdentifier("domain", domain);
      if (byDomain !== undefined) return byDomain;
    }
    const byName = this.#graph
      .search(name, { kinds: ["org"], limit: 5 })
      .find((o) => normalizeName(o.name) === normalizeName(name));
    if (byName !== undefined) return byName.id;
    return this.#graph.createEntity({
      kind: "org",
      name,
      source: "contacts",
      linkedBy: "rule",
      ...(domain === undefined ? {} : { identifiers: [{ kind: "domain", value: domain }] }),
    }).id;
  }

  // --- Mail ------------------------------------------------------------------------------------

  ingestMail(records: MailRecord[]): IngestReport {
    const report = emptyReport();
    const candidates =
      (this.#graph.cursor(CANDIDATES_KEY) as Record<string, Candidate> | undefined) ?? {};
    const threads =
      (this.#graph.cursor(THREADS_KEY) as Record<string, ThreadState> | undefined) ?? {};
    const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
    for (const m of sorted) {
      if (m.deleted === true) {
        if (this.#graph.deleteInteraction(m.source, m.messageId)) report.interactions++;
        continue;
      }
      const fromOwner = this.#isOwner(m.from.email);
      if (
        !fromOwner &&
        (isBulkMail(m.headers ?? {}) || isMachineOrRoleAddress(normalizeEmail(m.from.email) ?? ""))
      ) {
        report.skipped++;
        continue;
      }
      const thread = m.threadKey ?? m.messageId;
      const roles: [Address, ParticipantInput["role"]][] = [
        [m.from, "from"],
        ...(m.to ?? []).map((a): [Address, ParticipantInput["role"]] => [a, "to"]),
        ...(m.cc ?? []).map((a): [Address, ParticipantInput["role"]] => [a, "cc"]),
      ];
      const ownerInvolved = fromOwner || roles.some(([a]) => this.#isOwner(a.email));
      const participants: ParticipantInput[] = [];
      for (const [addr, role] of roles) {
        const email = normalizeEmail(addr.email);
        if (email === undefined || this.#ownerEmails.has(email) || isMachineOrRoleAddress(email))
          continue;
        if (this.#graph.isBlocked("email", email)) continue;
        let id = this.#graph.resolveIdentifier("email", email);
        if (id === undefined)
          id = this.#candidate(
            candidates,
            email,
            addr.name,
            thread,
            fromOwner && role !== "from",
            ownerInvolved,
            report,
          );
        if (id !== undefined) participants.push({ entityId: id, role });
      }
      if (participants.length === 0) {
        report.skipped++;
        continue;
      }
      const interactionId = this.#graph.upsertInteraction({
        kind: "mail",
        source: m.source,
        externalRef: m.messageId,
        occurredAt: m.date,
        direction: fromOwner ? "out" : "in",
        subject: m.subject ?? null,
        threadKey: thread,
        link: m.link ?? null,
        participants,
      });
      report.interactions++;
      this.#trackAsk(threads, thread, m, fromOwner, participants, interactionId, report);
    }
    // Keep the candidate map bounded: oldest-seen first out.
    const keys = Object.keys(candidates);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CANDIDATES))) delete candidates[k];
    this.#graph.setCursor(CANDIDATES_KEY, candidates);
    this.#graph.setCursor(THREADS_KEY, threads);
    return report;
  }

  /**
   * An unknown address becomes a person only past the threshold (§5.1): the owner wrote to them,
   * or they appear in two or more threads that involve the owner.
   */
  #candidate(
    candidates: Record<string, Candidate>,
    email: string,
    name: string | undefined,
    thread: string,
    ownerWroteTo: boolean,
    ownerInvolved: boolean,
    report: IngestReport,
  ): string | undefined {
    if (!ownerInvolved) return undefined;
    const c = candidates[email] ?? { names: [], threads: [], ownerSent: false };
    const clean = name?.replace(/["']/g, "").trim();
    if (clean !== undefined && clean.length > 0 && !clean.includes("@") && !c.names.includes(clean))
      c.names.push(clean);
    if (!c.threads.includes(thread)) c.threads.push(thread);
    c.threads = c.threads.slice(-10);
    c.names = c.names.slice(-5);
    if (ownerWroteTo) c.ownerSent = true;
    candidates[email] = c;
    if (!c.ownerSent && c.threads.length < 2) return undefined;
    delete candidates[email];
    const display = c.names[0] ?? email.split("@")[0] ?? email;
    const person = this.#graph.createEntity({
      kind: "person",
      name: display,
      identifiers: [{ kind: "email", value: email }],
      source: "mail",
      linkedBy: "rule",
    });
    report.created++;
    if (new Set(c.names.map(normalizeName)).size >= 2) this.#graph.markShared("email", email);
    for (const n of c.names.slice(1)) this.#graph.addAlias(person.id, n, "mail");
    // Same name and the same company domain as someone already known: ask the owner.
    const domain = email.split("@")[1] ?? "";
    if (!FREE_MAIL_DOMAINS.has(domain)) {
      for (const twin of this.#graph.search(display, { kinds: ["person"], limit: 5 })) {
        if (twin.id === person.id || normalizeName(twin.name) !== normalizeName(display)) continue;
        const twinDomains = this.#graph
          .identifiers(twin.id)
          .filter((i) => i.kind === "email")
          .map((i) => i.value.split("@")[1]?.toLowerCase());
        if (twinDomains.includes(domain)) {
          if (
            this.#graph.suggest({
              kind: "merge",
              entityIds: [twin.id, person.id],
              reason: `Same name and both write from ${domain}`,
            }) !== undefined
          )
            report.suggestions++;
        }
      }
    }
    return person.id;
  }

  /** The no-reply rule (§4.6): an owner ask with no reply after N days becomes `waiting_on`. */
  #trackAsk(
    threads: Record<string, ThreadState>,
    thread: string,
    m: MailRecord,
    fromOwner: boolean,
    participants: ParticipantInput[],
    interactionId: string,
    report: IngestReport,
  ): void {
    const state = threads[thread];
    if (fromOwner) {
      const to = participants.find((p) => p.role === "to")?.entityId;
      const text = (m.ownerSnippet ?? "").split("\n").find((l) => ASK.test(l));
      if (to !== undefined && text !== undefined) {
        threads[thread] = {
          counterpart: to,
          askedAt: m.date,
          text: text.trim().slice(0, 200),
          interactionId,
        };
      }
      return;
    }
    if (state === undefined) return;
    const from = participants.find((p) => p.role === "from")?.entityId;
    if (from !== state.counterpart) return;
    state.replied = true;
    if (state.loopId !== undefined) {
      const loop = this.#graph.getLoop(state.loopId);
      if (loop !== undefined && (loop.status === "open" || loop.status === "suggested")) {
        this.#graph.updateLoop(state.loopId, { status: "done", closedBy: "reply_seen" });
      }
    }
    delete threads[thread];
    void report;
  }

  /** Turns asks that are still unanswered after `noReplyDays` into `waiting_on` loops. */
  checkNoReply(): IngestReport {
    const report = emptyReport();
    const threads =
      (this.#graph.cursor(THREADS_KEY) as Record<string, ThreadState> | undefined) ?? {};
    const now = this.#clock.now();
    for (const [key, state] of Object.entries(threads)) {
      if (state.replied === true || state.loopId !== undefined) continue;
      if (now - Date.parse(state.askedAt) < this.#noReplyDays * DAY_MS) continue;
      if (this.#graph.getEntity(state.counterpart) === undefined) {
        delete threads[key];
        continue;
      }
      const loop = this.#graph.addLoop({
        direction: "waiting_on",
        text: state.text,
        evidence: state.text,
        counterpartId: state.counterpart,
        status: "open",
        sourceInteractionId: state.interactionId,
        provenance: "owner",
        confidence: 0.7,
        detectedBy: "rule",
      });
      if (loop !== undefined) {
        state.loopId = loop.id;
        report.loops++;
      }
    }
    this.#graph.setCursor(THREADS_KEY, threads);
    return report;
  }

  // --- Calendar --------------------------------------------------------------------------------

  /** Meetings are deliberate: their non-resource, non-machine attendees become people. */
  ingestEvents(records: EventRecord[]): IngestReport {
    const report = emptyReport();
    for (const e of records) {
      if (e.deleted === true) {
        if (this.#graph.deleteInteraction(e.source, e.id)) report.interactions++;
        continue;
      }
      const people: [Address, ParticipantInput["role"]][] = [
        ...(e.organizer === undefined
          ? []
          : [[e.organizer, "organizer"] as [Address, ParticipantInput["role"]]]),
        ...(e.attendees ?? [])
          .filter((a) => a.resource !== true)
          .map((a): [Address, ParticipantInput["role"]] => [a, "attendee"]),
      ];
      const participants: ParticipantInput[] = [];
      for (const [addr, role] of people) {
        const email = normalizeEmail(addr.email);
        if (email === undefined || this.#ownerEmails.has(email) || isMachineOrRoleAddress(email))
          continue;
        if (this.#graph.isBlocked("email", email)) continue;
        let id = this.#graph.resolveIdentifier("email", email);
        if (id === undefined) {
          id = this.#graph.createEntity({
            kind: "person",
            name: addr.name?.trim() || (email.split("@")[0] ?? email),
            identifiers: [{ kind: "email", value: email }],
            source: "calendar",
            linkedBy: "rule",
          }).id;
          report.created++;
        }
        if (!participants.some((p) => p.entityId === id)) participants.push({ entityId: id, role });
      }
      if (participants.length === 0) {
        report.skipped++;
        continue;
      }
      this.#graph.upsertInteraction({
        kind: "meeting",
        source: e.source,
        externalRef: e.id,
        occurredAt: e.start,
        direction: "both",
        subject: e.title ?? null,
        link: e.link ?? null,
        participants,
      });
      report.interactions++;
    }
    return report;
  }

  // --- Messages and channels -------------------------------------------------------------------

  /** One interaction per conversation per day; 1:1 conversations the owner took part in create people. */
  ingestMessages(records: MessageRecord[]): IngestReport {
    const report = emptyReport();
    for (const m of records) {
      const participants: ParticipantInput[] = [];
      for (const h of m.handles) {
        const ident = this.#handle(h.value);
        if (ident === undefined) continue;
        if (this.#graph.isBlocked(ident.kind, ident.value)) continue;
        let id = this.#graph.resolveIdentifier(ident.kind, ident.value);
        if (id === undefined && m.ownerSpoke && m.isGroup !== true) {
          id = this.#graph.createEntity({
            kind: "person",
            name: h.name?.trim() || h.value,
            identifiers: [ident],
            source: m.source,
            linkedBy: "rule",
          }).id;
          report.created++;
        }
        if (id !== undefined)
          participants.push({ entityId: id, role: m.isGroup === true ? "to" : "from" });
      }
      if (participants.length === 0) {
        report.skipped++;
        continue;
      }
      this.#graph.upsertInteraction({
        kind: "message",
        source: m.source,
        externalRef: `${m.chatId}:${m.date.slice(0, 10)}`,
        occurredAt: m.date,
        direction: m.ownerSpoke ? "both" : "in",
        subject: null,
        threadKey: m.chatId,
        link: m.link ?? null,
        participants,
      });
      report.interactions++;
    }
    return report;
  }

  #handle(raw: string): { kind: GraphIdentifierKind; value: string } | undefined {
    const v = raw.trim();
    if (/^[a-z]+:/.test(v) && !v.startsWith("mailto:") && !v.startsWith("tel:"))
      return { kind: "channel", value: v };
    const stripped = v.replace(/^(mailto|tel):/, "");
    const email = normalizeEmail(stripped);
    if (email !== undefined)
      return this.#ownerEmails.has(email) ? undefined : { kind: "email", value: email };
    const phone = normalizePhone(stripped, this.#country);
    if (phone !== undefined)
      return this.#ownerPhones.has(phone) ? undefined : { kind: "phone", value: phone };
    return undefined;
  }

  // --- Chats with Psyche -----------------------------------------------------------------------

  /**
   * Projects the owner names in chat ("my kitchen remodel"): created as owner projects. People
   * the learner mentions are left to the model pass, which can tell who is meant.
   */
  /**
   * Known people, organisations and projects named in `text` by a whole name or alias (≥ 3
   * characters) that no other entity shares. Never the owner, a hidden entity, or one whose
   * identifiers are blocklisted. Nothing is ever created from a mention.
   */
  #mentions(text: string, index: Map<string, string[]>): string[] {
    const words = ` ${normalizeName(text)} `;
    const found = new Set<string>();
    for (const [name, ids] of index) {
      if (ids.length !== 1 || !words.includes(` ${name} `)) continue;
      found.add(ids[0] as string);
    }
    return [...found];
  }

  #mentionIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const e of this.#graph.listEntities(["person", "org", "project"])) {
      if (e.isOwner || e.hidden || e.status !== "active") continue;
      if (this.#graph.identifiers(e.id).some((i) => this.#graph.isBlocked(i.kind, i.value)))
        continue;
      for (const n of new Set([e.name, ...e.aliases].map(normalizeName))) {
        if (n.length < 3) continue;
        index.set(n, [...(index.get(n) ?? []), e.id]);
      }
    }
    return index;
  }

  /**
   * Notes titled with a known name become `mentioned` links (titles only; bodies are never read
   * here). A note's text may be pasted from anywhere, so it never counts as the owner's own words.
   */
  ingestNotes(records: NoteRecord[]): IngestReport {
    const report = emptyReport();
    const index = this.#mentionIndex();
    for (const n of records) {
      const mentioned = n.deleted === true ? [] : this.#mentions(n.title, index);
      if (mentioned.length === 0) {
        // Deleted, or renamed so it no longer names anyone: its link goes.
        if (this.#graph.deleteInteraction(n.source, n.id)) report.interactions++;
        else report.skipped++;
        continue;
      }
      this.#graph.upsertInteraction({
        kind: "note",
        source: n.source,
        externalRef: n.id,
        occurredAt: n.modifiedAt,
        direction: "both",
        subject: n.title,
        link: n.link ?? null,
        participants: mentioned.map((entityId) => ({ entityId, role: "mentioned" })),
      });
      report.interactions++;
    }
    return report;
  }

  /**
   * The owner's chats with Psyche: one `chat` interaction per thread per day linking the people
   * and projects the owner named. The words themselves are not stored (no subject).
   */
  ingestChats(records: ChatRecord[]): IngestReport {
    const report = emptyReport();
    const index = this.#mentionIndex();
    const days = new Map<string, { record: ChatRecord; last: string; ids: Set<string> }>();
    for (const r of records) {
      const key = `${r.threadId}:${r.date.slice(0, 10)}`;
      const day = days.get(key) ?? { record: r, last: r.date, ids: new Set<string>() };
      for (const id of this.#mentions(r.text, index)) day.ids.add(id);
      if (r.date > day.last) day.last = r.date;
      days.set(key, day);
    }
    for (const [key, day] of days) {
      if (day.ids.size === 0) {
        report.skipped++;
        continue;
      }
      // Merge with what an earlier pass found for the same thread and day.
      const existing = this.#graph.interactionByRef(day.record.source, key);
      for (const p of existing?.participants ?? []) day.ids.add(p.entityId);
      this.#graph.upsertInteraction({
        kind: "chat",
        source: day.record.source,
        externalRef: key,
        occurredAt:
          existing !== undefined && existing.occurredAt > day.last ? existing.occurredAt : day.last,
        direction: "out",
        subject: null,
        threadKey: day.record.threadId,
        link: day.record.link ?? null,
        participants: [...day.ids].map((entityId) => ({ entityId, role: "mentioned" })),
      });
      report.interactions++;
    }
    return report;
  }

  ingestOwnerProjects(names: { name: string; threadId: string }[]): IngestReport {
    const report = emptyReport();
    for (const p of names) {
      const name = p.name.replace(/^(my|our|the)\s+/i, "").trim();
      if (name.length < 3 || name.length > 60) {
        report.skipped++;
        continue;
      }
      const existing = this.#graph
        .search(name, { kinds: ["project"], limit: 3, includeArchived: true })
        .find((x) => normalizeName(x.name) === normalizeName(name));
      if (existing !== undefined) continue;
      this.#graph.createEntity({
        kind: "project",
        name: name.charAt(0).toUpperCase() + name.slice(1),
        source: `chat:${p.threadId}`,
      });
      report.created++;
    }
    return report;
  }
}
