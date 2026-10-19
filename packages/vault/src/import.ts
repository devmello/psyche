import type { CredentialBinding, CredentialKind } from "@psyche/protocol";
import { canonicalOrigin } from "./binding.ts";
import { type RefusalCategory, refusedFieldName, scanText } from "./refusals.ts";
import type { ItemSecret } from "./store.ts";
import { parseTotpSeed } from "./totp.ts";

export type ImportFormat = "1password" | "bitwarden" | "chrome";

/** RFC 4180 CSV: quoted fields, doubled quotes, CR/LF/CRLF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim().length > 0));
}

export function detectFormat(header: string[]): ImportFormat | null {
  const h = new Set(header.map((c) => c.trim().toLowerCase()));
  if (h.has("login_uri") && h.has("login_password")) return "bitwarden";
  if (h.has("title") && h.has("password") && (h.has("url") || h.has("website"))) {
    return "1password";
  }
  if (h.has("name") && h.has("url") && h.has("username") && h.has("password")) return "chrome";
  return null;
}

/** One row ready for `Vault.add`, or the reason it was skipped. Never echoes values. */
export type ImportedRow =
  | {
      ok: true;
      row: number;
      kind: CredentialKind;
      name: string;
      bindings: CredentialBinding[];
      secret: ItemSecret;
      warnings: string[];
    }
  | { ok: false; row: number; reason: string };

function bindingsFrom(uris: string, warnings: string[]): CredentialBinding[] {
  const out: CredentialBinding[] = [];
  for (const raw of uris.split(/[\n,]/)) {
    const uri = raw.trim();
    if (uri.length === 0) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(uri) ? uri : `https://${uri}`;
    const origin = canonicalOrigin(withScheme);
    if (origin === null) {
      warnings.push("skipped a non-web URI");
      continue;
    }
    if (!out.some((b) => "origin" in b && b.origin === origin)) out.push({ origin });
  }
  if (out.length === 0)
    warnings.push("no web origin: the item cannot be filled until one is bound");
  return out;
}

function refused(category: RefusalCategory, where: string): string {
  return `refused: ${category} in ${where}`;
}

/**
 * Map an export to vault rows. Card, identity and bank rows are refused, as is any row whose
 * fields hold a card number, CVV, bank account or government id (security §4.4).
 */
export function importRows(
  csv: string,
  format: ImportFormat | "auto",
): {
  format: ImportFormat;
  rows: ImportedRow[];
} {
  const table = parseCsv(csv);
  const header = (table[0] ?? []).map((c) => c.trim().toLowerCase());
  const detected = format === "auto" ? detectFormat(header) : format;
  if (detected === null) throw new RangeError("unrecognized CSV export header");
  const col = (row: string[], ...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return row[i] ?? "";
    }
    return "";
  };
  const known = new Set(
    {
      chrome: ["name", "url", "username", "password", "note"],
      bitwarden: [
        "folder",
        "favorite",
        "type",
        "name",
        "notes",
        "fields",
        "reprompt",
        "login_uri",
        "login_username",
        "login_password",
        "login_totp",
      ],
      "1password": [
        "title",
        "url",
        "website",
        "username",
        "password",
        "otpauth",
        "favorite",
        "archived",
        "tags",
        "notes",
        "notesplain",
        "type",
      ],
    }[detected],
  );
  const rows: ImportedRow[] = [];
  table.slice(1).forEach((r, idx) => {
    const rowNo = idx + 2;
    for (let c = 0; c < header.length; c += 1) {
      const name = header[c] ?? "";
      const value = r[c] ?? "";
      if (value.trim().length === 0) continue;
      const byName = refusedFieldName(name);
      if (byName !== null || (!known.has(name) && /number|cvv|cvc|verification|expir/.test(name))) {
        rows.push({ ok: false, row: rowNo, reason: refused(byName ?? "card_number", name) });
        return;
      }
    }
    const type = col(r, "type").trim().toLowerCase();
    if (/card|identity|bank|passport|license|ssn/.test(type)) {
      rows.push({ ok: false, row: rowNo, reason: `refused: ${type} items` });
      return;
    }
    const name = col(r, "name", "title").trim() || "Imported item";
    const notes = col(r, "notes", "notesplain", "note");
    const isNote = detected === "bitwarden" ? type === "note" : type === "secure note";
    const fields: Record<string, string> = {
      name,
      notes,
      username: col(r, "login_username", "username"),
      password: col(r, "login_password", "password"),
    };
    for (const [where, value] of Object.entries(fields)) {
      const category = value.length > 0 ? scanText(value) : null;
      if (category !== null) {
        rows.push({ ok: false, row: rowNo, reason: refused(category, where) });
        return;
      }
    }
    const warnings: string[] = [];
    if (isNote) {
      rows.push({
        ok: true,
        row: rowNo,
        kind: "note",
        name,
        bindings: [],
        secret: { text: notes },
        warnings,
      });
      return;
    }
    const secret: ItemSecret = {};
    if (fields.username) secret.username = fields.username;
    if (fields.password) secret.password = fields.password;
    if (notes) secret.text = notes;
    const totp = col(r, "login_totp", "otpauth").trim();
    if (totp) {
      try {
        parseTotpSeed(totp);
        secret.totpSecret = totp;
      } catch {
        warnings.push("dropped an unreadable TOTP seed");
      }
    }
    if (secret.password === undefined && secret.totpSecret === undefined) {
      rows.push({ ok: false, row: rowNo, reason: "no password or TOTP seed" });
      return;
    }
    rows.push({
      ok: true,
      row: rowNo,
      kind: "login",
      name,
      bindings: bindingsFrom(col(r, "login_uri", "url", "website"), warnings),
      secret,
      warnings,
    });
  });
  return { format: detected, rows };
}
