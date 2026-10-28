import type { SourceExclusions, SourceItem } from "./types.ts";

const norm = (s: string): string => s.normalize("NFC").trim().toLowerCase();
/** Phone numbers compare by their digits (`+1 (510) 555-0101` = `15105550101`). */
const digits = (s: string): string => s.replace(/\D/g, "");
const isPhone = (s: string): boolean => /^[+()\d\s.-]{7,}$/.test(s);

/** Everything a party string can be compared as: itself, and its digits when it looks like a number. */
function forms(s: string): string[] {
  const n = norm(s);
  if (n === "") return [];
  return isPhone(n) && digits(n).length >= 7 ? [n, digits(n)] : [n];
}

/** Address inside `Name <a@b.c>`. */
export function addressOf(s: string): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  return m?.[1] ?? s;
}

/** Whether an item involves anything the owner excluded. */
export function isExcluded(item: SourceItem, ex: SourceExclusions): boolean {
  const contacts = new Set(ex.contacts.flatMap(forms));
  if (contacts.size > 0) {
    for (const p of [...(item.parties ?? []), ...(item.from === undefined ? [] : [item.from])]) {
      for (const f of [...forms(p), ...forms(addressOf(p))]) if (contacts.has(f)) return true;
    }
  }
  if (item.chatId !== undefined && ex.chats.some((c) => norm(c) === norm(item.chatId ?? "")))
    return true;
  if (item.account !== undefined && ex.accounts.some((a) => norm(a) === norm(item.account ?? "")))
    return true;
  if (item.path !== undefined) {
    const p = norm(item.path);
    if (ex.folders.some((f) => p === norm(f) || p.startsWith(`${norm(f).replace(/\/+$/, "")}/`)))
      return true;
  }
  return false;
}
