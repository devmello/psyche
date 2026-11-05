import type { SourceExclusions, SourceItem } from "./types.ts";

const norm = (s: string): string => s.normalize("NFC").trim().toLowerCase();
const isPhone = (s: string): boolean => /^[+()\d\s.-]{7,}$/.test(s);
/** A trailing extension (`x123`, `ext. 4`, `#12`): not part of the number when matching. */
const EXTENSION = /\s*(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i;

/** A phone number as it is compared. */
interface Phone {
  /** Written with a country code (`+`, or `00`): `digits` are then the full international number. */
  international: boolean;
  /** International: country code and number. National: the national significant number (a leading trunk 0 dropped). */
  digits: string;
}

/** The number a string is, or undefined when it is not one (fewer than seven digits, letters). */
function phoneOf(s: string): Phone | undefined {
  const n = norm(s).replace(EXTENSION, "");
  if (!isPhone(n)) return undefined;
  const d = n.replace(/\D/g, "");
  if (d.length < 7) return undefined;
  if (n.startsWith("+")) return { international: true, digits: d };
  if (d.startsWith("00") && d.length > 9) return { international: true, digits: d.slice(2) };
  const nsn = d.replace(/^0+/, "");
  return nsn.length < 7 ? undefined : { international: false, digits: nsn };
}

/**
 * The numbers the owner excluded, indexed so a party is checked in a few lookups. Two numbers with
 * a country code are the same only when equal in full (so a US 791 112 3456 is not a UK
 * 7911 123456). When one side has no country code, the national significant number decides: the
 * international number ends with it (`030 1234567` is `+49 30 1234567`, `(555) 123-4567` is
 * `+1 555 123 4567`). Extensions are ignored.
 */
function phoneIndex(excluded: readonly string[]) {
  const intl = new Set<string>();
  /** Every suffix (seven digits or more, the whole number too, for a bare 15105550101) of an international exclusion. */
  const intlSuffixes = new Set<string>();
  const national = new Set<string>();
  for (const e of excluded) {
    const ph = phoneOf(e);
    if (ph === undefined) continue;
    if (ph.international) {
      intl.add(ph.digits);
      for (let i = 0; ph.digits.length - i >= 7; i++) intlSuffixes.add(ph.digits.slice(i));
    } else national.add(ph.digits);
  }
  return (party: string): boolean => {
    const ph = phoneOf(party);
    if (ph === undefined) return false;
    if (ph.international) {
      if (intl.has(ph.digits)) return true;
      // Excluded without a country code: its national number is the end of this one.
      for (let i = 0; ph.digits.length - i >= 7; i++)
        if (national.has(ph.digits.slice(i))) return true;
      return false;
    }
    return national.has(ph.digits) || intlSuffixes.has(ph.digits);
  };
}

/** Address inside `Name <a@b.c>`. */
export function addressOf(s: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  return m?.[1] ?? s;
}

/** Whether an item involves anything the owner excluded. */
export function isExcluded(item: SourceItem, ex: SourceExclusions): boolean {
  const texts = new Set(ex.contacts.map(norm).filter((x) => x !== ""));
  if (texts.size > 0) {
    const samePhone = phoneIndex(ex.contacts);
    for (const p of [...(item.parties ?? []), ...(item.from === undefined ? [] : [item.from])]) {
      for (const f of [norm(p), norm(addressOf(p))]) {
        if (f !== "" && texts.has(f)) return true;
        if (samePhone(f)) return true;
      }
    }
  }
  if (item.chatId !== undefined && ex.chats.some((c) => norm(c) === norm(item.chatId ?? "")))
    return true;
  if (item.account !== undefined && ex.accounts.some((a) => norm(a) === norm(item.account ?? "")))
    return true;
  if (item.path !== undefined) {
    // Folders compare with "/" whatever the separator (Windows paths use "\\").
    const slash = (s: string) => norm(s).replaceAll("\\", "/");
    const p = slash(item.path);
    if (ex.folders.some((f) => p === slash(f) || p.startsWith(`${slash(f).replace(/\/+$/, "")}/`)))
      return true;
  }
  return false;
}
