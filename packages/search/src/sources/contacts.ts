import type { HelperCall } from "./apple.ts";
import type { SourceAdapter, SourceItem, SourcePull } from "./types.ts";

/**
 * Contacts as a Search source: the owner's address book (Apple Contacts, read by the Mac helper),
 * so Search finds a person by name, nickname, company, email, number or city.
 *
 * What is indexed from a contact: display name, nickname, organization and job title, email
 * addresses, phone numbers, the city and country of each postal address, and the birthday. What
 * is not: street, state and postal code, URLs and social profiles, groups, and the note. (The
 * helper never reads the note, which can hold anything, such as a door code or a medical remark,
 * and needs an Apple-granted entitlement; `contacts.read` says so. This adapter would not index it
 * if it did.)
 *
 * It only parses: the Gateway hands in `helper` (the Host's own Mac helper, the trusted in-process
 * path, never the client-facing `nodes.invoke`), so tests run on fixtures and no real Contacts
 * store is read from here. A contact is an item whose `parties` are its name, nickname, emails and
 * numbers, so the owner's "never index these contacts" list skips it and purges what was indexed.
 * Results collapse onto the person's own Memory document when `parentOf` knows the person.
 *
 * The helper has no change feed, so a pass lists every contact once (`contacts.list` pages with
 * `offset`, 2000 a call, so the list is complete) and reads one page of them with `contacts.read`; when it reaches
 * the end it waits `CONTACTS_REFRESH_MS`, then starts over to pick up edits (an unchanged contact
 * is skipped by its content hash). The nightly sweep forgets contacts that were deleted.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;

/** The most `contacts.list` returns in one call (the helper's `maxLimit`); more are paged by `offset`. */
export const CONTACTS_LIST_LIMIT = 2000;
/** Contacts read per pull: each is one helper call, so a pull stays short. */
export const CONTACTS_PAGE = 50;
/** A finished pass is not repeated sooner than this: the address book has no change feed. */
export const CONTACTS_REFRESH_MS = 6 * 3_600_000;

const NO_HELPER = "the Mac helper is not connected";

export interface ContactsSourceDeps {
  /** The Host's Mac helper offering `contacts.list` and `contacts.read`; undefined while none is live. */
  helper: () => HelperCall | undefined;
  /**
   * The id of the Memory person document this contact is the same person as (matched by the Apple
   * contact id the people graph recorded, never by an email or number another source could have
   * planted), so results collapse onto it; undefined when nobody matches.
   */
  parentOf?: (contact: { id: string; emails: string[]; phones: string[] }) => string | undefined;
  now: () => number;
}

interface ListedContacts {
  /** In the helper's stable order, with the name Contacts shows for each (middle name, prefix). */
  contacts: { id: string; name: string | undefined }[];
  /** False when paging could not prove it saw every contact (an older helper without `offset`). */
  complete: boolean;
}

const labeled = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        const value = isObj(x) ? str(x.value) : str(x);
        return value === undefined ? [] : [value];
      })
    : [];

/** A safety stop for a list that never ends: 500 pages of 2000. */
const MAX_LIST_PAGES = 500;

/**
 * Every contact the helper lists, paged with `offset` (2000 a call). A helper that ignores
 * `offset` hands back the first page again: that ends the walk and the list is not complete, so a
 * sweep deletes nothing on it.
 */
async function listAll(helper: HelperCall, signal: AbortSignal): Promise<ListedContacts> {
  const contacts: ListedContacts["contacts"] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MAX_LIST_PAGES && !signal.aborted; page++) {
    const out = await helper(
      "contacts.list",
      { limit: CONTACTS_LIST_LIMIT, ...(page > 0 ? { offset: contacts.length } : {}) },
      signal,
    );
    const o = isObj(out) ? out : {};
    let added = 0;
    for (const c of Array.isArray(o.contacts) ? o.contacts : []) {
      const id = isObj(c) ? str(c.id) : undefined;
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      contacts.push({ id, name: isObj(c) ? str(c.name) : undefined });
      added += 1;
    }
    if (o.truncated !== true) return { contacts, complete: true };
    if (added === 0) return { contacts, complete: false };
  }
  return { contacts, complete: false };
}

/** One search item from a `contacts.read` result, or undefined for an empty contact. */
export function contactItem(
  raw: unknown,
  now: number,
  parentOf?: ContactsSourceDeps["parentOf"],
  /** The name `contacts.list` gave (Contacts' own full name, with middle name and prefix). */
  listedName?: string,
): SourceItem | undefined {
  const c = isObj(raw) && isObj(raw.contact) ? raw.contact : isObj(raw) ? raw : {};
  const id = str(c.id);
  if (id === undefined) return undefined;
  const given = str(c.givenName);
  const family = str(c.familyName);
  const nickname = str(c.nickname);
  const org = str(c.organization);
  const job = str(c.jobTitle);
  const emails = labeled(c.emails);
  const phones = labeled(c.phones);
  const fullName = [given, family].filter((x) => x !== undefined).join(" ");
  const name =
    listedName ?? (fullName !== "" ? fullName : (nickname ?? org ?? emails[0] ?? phones[0]));
  if (name === undefined) return undefined;
  // City and country only: a street address is the most identifying part and the least useful to
  // find a person by.
  const places = [
    ...new Set(
      (Array.isArray(c.addresses) ? c.addresses : []).flatMap((a) => {
        const place = isObj(a)
          ? [str(a.city), str(a.country)].filter((x) => x !== undefined).join(", ")
          : "";
        return place === "" ? [] : [place];
      }),
    ),
  ];
  const birthday = str(c.birthday);
  const lines = [
    name,
    nickname !== undefined && nickname !== name ? `Nickname: ${nickname}` : "",
    org !== undefined && org !== name ? `Organization: ${org}` : "",
    job === undefined ? "" : `Job title: ${job}`,
    emails.length > 0 ? `Email: ${emails.join(", ")}` : "",
    phones.length > 0 ? `Phone: ${phones.join(", ")}` : "",
    places.length > 0 ? `Location: ${places.join("; ")}` : "",
    birthday === undefined ? "" : `Birthday: ${birthday}`,
  ].filter((l) => l !== "");
  const parent = parentOf?.({ id, emails, phones });
  return {
    nativeId: id,
    title: name,
    text: lines.join("\n"),
    // No dates in an address book: the first time it was read (an unchanged contact is skipped by
    // its hash, so this stays).
    createdAt: now,
    // Helper results carry `provenance: untrusted` (contacts sync from mail signatures and shared
    // cards); keep that, so Search shows it as other people's text.
    provenance: "untrusted",
    tags: ["contact"],
    parties: [
      ...new Set(
        // The shown name (Contacts' own, with middle name and prefix), the given and family
        // name, the nickname, a company that is the name of a company-only card, and every
        // address and number: whatever the owner could type into "Never index these contacts".
        [name, fullName, nickname, org === name ? org : undefined, ...emails, ...phones].filter(
          (x): x is string => x !== undefined && x !== "",
        ),
      ),
    ],
    ...(parent === undefined ? {} : { parentId: parent }),
  };
}

interface Cursor {
  /** Index into the helper's stable ordering where the next page starts. */
  i: number;
  /** When the last pass reached the end; a new pass waits `CONTACTS_REFRESH_MS` after it. */
  doneAt?: number;
}

const cursorOf = (raw: unknown): Cursor =>
  isObj(raw) && typeof raw.i === "number"
    ? {
        i: Math.max(0, Math.floor(raw.i)),
        ...(typeof raw.doneAt === "number" ? { doneAt: raw.doneAt } : {}),
      }
    : { i: 0 };

/** How long one pass reuses the list of contacts it already read (a pass is a few pulls). */
const LISTING_TTL_MS = 5 * 60_000;

export function contactsAdapter(deps: ContactsSourceDeps): SourceAdapter {
  // The list a pass is working through: listing is one helper call per 2000 contacts, so it is
  // done once per pass and not once per page of 50.
  let listed: { contacts: ListedContacts["contacts"]; at: number } | undefined;
  return {
    id: "contacts",
    unavailable: () => (deps.helper() === undefined ? NO_HELPER : undefined),
    async pull(raw, { signal, limit }): Promise<SourcePull> {
      const helper = deps.helper();
      if (helper === undefined) throw new Error(NO_HELPER);
      const cur = cursorOf(raw);
      const now = deps.now();
      // The last pass is recent: nothing to read until it is due again.
      if (cur.doneAt !== undefined && now - cur.doneAt < CONTACTS_REFRESH_MS)
        return { items: [], cursor: cur, hasMore: false };
      const start = cur.doneAt === undefined ? cur.i : 0;
      // A permission error from the helper surfaces here with its own message ("Psyche (Helper)
      // does not have the Contacts permission"); Settings shows it on the row.
      let contacts: ListedContacts["contacts"];
      if (start > 0 && listed !== undefined && now - listed.at < LISTING_TTL_MS) {
        contacts = listed.contacts;
      } else {
        contacts = (await listAll(helper, signal)).contacts;
        listed = { contacts, at: now };
      }
      const page = contacts.slice(start, start + Math.min(limit, CONTACTS_PAGE));
      const items: SourceItem[] = [];
      let read = 0;
      for (const { id, name: listedName } of page) {
        if (signal.aborted) break;
        read += 1;
        let out: unknown;
        try {
          out = await helper("contacts.read", { id }, signal);
        } catch (err) {
          // Deleted since the list was read: the sweep will see it is gone. Anything else (the
          // permission was revoked) stops the pass with the helper's message.
          if (/not_found|No contact/i.test(err instanceof Error ? err.message : String(err)))
            continue;
          throw err;
        }
        const item = contactItem(out, now, deps.parentOf, listedName);
        if (item !== undefined) items.push(item);
      }
      const next = start + read;
      const hasMore = next < contacts.length;
      return { items, cursor: hasMore ? { i: next } : { i: next, doneAt: now }, hasMore };
    },
    async listIds(signal) {
      const helper = deps.helper();
      if (helper === undefined) return { ids: [], complete: false };
      const { contacts, complete } = await listAll(helper, signal);
      return { ids: contacts.map((c) => c.id), complete };
    },
  };
}
