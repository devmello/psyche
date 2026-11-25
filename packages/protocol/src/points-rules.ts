import { classifyTeachField, classifyTeachValue } from "./browser-teach.ts";
import { venueOfHost } from "./financial-block.ts";
import { isMoneyContext, isPaymentField, NOT_PAYMENT_CARD } from "./money-intent.ts";
import type { PointsSensitiveReason } from "./schemas/points.ts";

/**
 * Psyche points, shared rules (docs/design/psyche-points-2026.md §3.3, §5.1, W1). Pure, with no
 * Node imports: the Gateway's plan checker (W6) applies them to what the model wrote, and the
 * Mac helper's judge (W3) is tested against the same rows (`test/fixtures/points-sensitive.json`).
 *
 * - **Sensitive fields** are decided from the field alone, before any value is read. The shared
 *   teach rules (`classifyTeachField`) and the payment rule (`isPaymentField`, `isMoneyContext`,
 *   `venueOfHost`) come first and are reused as they are. Points-only additions (A-Number, ITIN,
 *   the shipped languages, security questions) live here, so teach by showing does not change.
 *   Near-misses ("Library card number", "Passport photo upload", "Pass note") are removed as
 *   narrow phrases before the words run: whatever else the label says is still judged.
 * - **A false match fails safe.** A field wrongly judged sensitive only gets "You fill this
 *   yourself".
 * - **Grounding.** A suggested value must trace to the owner's goal or a trusted Memory line, by
 *   the rule its `derivation` names, or it is dropped. Psyche never makes up a value.
 * - **The sanitizer** makes model text safe to draw: plain text, no links or addresses, no control,
 *   format or bidi characters (the NEL class of #1537 included).
 */

// ---- Sensitive fields ----

/** What the helper or Gateway knows about one field. Every text is the page's own (untrusted). */
export interface PointsFieldFacts {
  label?: string | undefined;
  placeholder?: string | undefined;
  /** `AXHelp` and the like. */
  help?: string | undefined;
  /** `AXIdentifier` or the page's `name` and `id`. */
  identifier?: string | undefined;
  autocomplete?: string | undefined;
  /** `AXSecureTextField`, or Secure Event Input is on. */
  secure?: boolean | undefined;
  /** Group and sheet titles above the field, outermost first. */
  path?: readonly string[] | undefined;
  /** The few static texts just before the field. */
  nearbyText?: readonly string[] | undefined;
}

/** What the page tells us (§2.2). */
export interface PointsPageFacts {
  url?: string | undefined;
  host?: string | undefined;
  title?: string | undefined;
  /** The page has card fields. */
  hasPaymentFields?: boolean | undefined;
  /** The page is served over plain `http:`. */
  insecure?: boolean | undefined;
}

type Reason = Exclude<PointsSensitiveReason, "secure_field" | "value_shape" | "directions_only">;

/**
 * Points-only words, beyond `TEACH_SENSITIVE_WORDS`: regex sources matched case-insensitively
 * against NFKC text, and again against the same text with Latin accents removed (so the Latin
 * sources are written without accents). The shipped languages: en, es, fr, de, it, pt, ja, ko,
 * zh (simplified and traditional), hi, ar. No `\b` around non-Latin words: it does not work there.
 */
export const POINTS_SENSITIVE_WORDS: readonly { reason: Reason; source: string }[] = [
  {
    reason: "password",
    source: [
      "password[- ]hint|passcode",
      "contrasena|clave de acceso",
      "mot de passe|identifiant de connexion",
      "kennwort|passwort",
      "パスワード|비밀번호|密码|密碼",
      "पासवर्ड|كلمة المرور|كلمه المرور",
    ].join("|"),
  },
  {
    reason: "one_time_code",
    source: [
      "two[- ]?factor|2[- ]?step|two[- ]?step|multi[- ]?factor|authenticator|one[- ]time (?:code|password|pin)",
      "codigo de verificacion|verificacion en dos pasos|codigo de un solo uso",
      "code de verification|double authentification|authentification (?:a|en) deux facteurs|code a usage unique",
      "zwei[- ]?faktor|verifizierungscode|bestatigungscode|einmalcode|einmalpasswort",
      "codice di verifica|verifica in due passaggi|codice monouso",
      "codigo de verificacao|verificacao em duas etapas|autenticacao em dois fatores|codigo de uso unico",
      "認証コード|確認コード|二要素|二段階認証|ワンタイム",
      "인증\\s?번호|인증\\s?코드|2단계|일회용",
      "验证码|驗證碼|两步验证|兩步驟驗證|动态密码|動態密碼",
      "सत्यापन कोड|ओटीपी|दो-चरण",
      "رمز التحقق|رمز التأكيد|المصادقة الثنائية",
    ].join("|"),
  },
  {
    reason: "payment",
    source: [
      // English
      "\\bcvv2?\\b|\\bcvc2?\\b|\\bccv\\b|card verification|\\bcard (?:security )?code\\b|credit card|debit card",
      "routing\\s*(?:no\\b|#|transit)|\\baba\\b number|transit number|\\bbsb\\b|\\bifsc\\b|\\bbic\\b|\\bacct\\b|account no\\b|bank account",
      "direct deposit",
      // es
      "numero de (?:la )?tarjeta|codigo de seguridad|cuenta bancaria|numero de cuenta|\\bclabe\\b|tarjeta de (?:credito|debito)",
      // fr
      "numero de (?:la )?carte|carte bancaire|code de securite|cryptogramme|numero de compte|\\brib\\b|code banque",
      // de
      "kartennummer|kreditkarte|sicherheitscode|kartenprufnummer|prufziffer|kontonummer|bankleitzahl|\\bblz\\b",
      // it
      "numero (?:di|della) carta|codice di sicurezza|numero di conto|carta di credito|coordinate bancarie",
      // pt
      "numero do cartao|numero de cartao|codigo de seguranca|numero da conta|conta bancaria|cartao de credito",
      // ja
      "カード番号|セキュリティコード|口座番号|支店コード|クレジットカード",
      // ko
      "카드\\s?번호|보안\\s?코드|계좌\\s?번호|신용카드",
      // zh
      "卡号|卡號|银行卡|銀行卡|信用卡|安全码|安全碼|银行账|銀行帳|银行账户|账号|賬號|帳號",
      // hi
      "कार्ड नंबर|कार्ड संख्या|सीवीवी|खाता संख्या|खाता नंबर|आईएफएससी",
      // ar
      "رقم البطاقة|رمز الأمان|رقم الحساب|الآيبان|رقم الآيبان",
    ].join("|"),
  },
  {
    reason: "identity",
    source: [
      // English: the US paperwork forms ask for these by name
      "a[- ]?number|alien registration|\\bitin\\b|\\bein\\b number|employer identification|social insurance|national insurance|\\bnino\\b|\\bsin number\\b|\\baadhaar\\b|visa (?:control )?number|taxpayer identification|tax identification",
      // es
      "pasaporte|\\bdni\\b|\\bnie\\b|\\bnif\\b|\\bcurp\\b|seguro social|documento de identidad|identificacion fiscal|licencia de conducir|permiso de conducir",
      // fr
      "passeport|securite sociale|numero fiscal|permis de conduire|carte d'identite|piece d'identite",
      // de
      "reisepass|sozialversicherungsnummer|steuer[- ]?id|steueridentifikationsnummer|personalausweis|fuhrerschein|ausweisnummer",
      // it
      "codice fiscale|passaporto|carta d'identita|patente di guida|numero di patente",
      // pt
      "passaporte|\\bcpf\\b|\\bcnh\\b|seguro social|carteira de motorista|identificacao fiscal",
      // ja
      "パスポート|マイナンバー|社会保骜|運転免許|在留カード|旅券",
      // ko
      "여권|주민등록|외국인등록|운전면허",
      // zh
      "护照|護照|身份证|身份證|社会保障|社會保障|驾驶证|駕駛證|税号|稅號|纳税人识别号",
      // hi
      "पासपोर्ट|आधार|पैन कार्ड|ड्राइविंग लाइसेंस",
      // ar
      "جواز السفر|رقم الهوية|الرقم القومي|رخصة القيادة",
    ].join("|"),
  },
  {
    reason: "secret",
    source: [
      // A security question's answer unlocks an account like a password does.
      "security[- ]question|secret[- ]question|security[- ]answer|memorable (?:word|information)|mother'?s maiden",
      "pregunta de seguridad|pregunta secreta|question de securite|question secrete|code secret|sicherheitsfrage|geheimzahl|domanda di sicurezza|codice segreto|pergunta de seguranca|pergunta secreta",
      "セキュリティの質問|秘密の質問|보안\\s?질문|安全问题|安全問題|密保",
      "सुरक्षा प्रश्न|سؤال الأمان",
    ].join("|"),
  },
];

const POINTS_WORDS = POINTS_SENSITIVE_WORDS.map((w) => ({
  reason: w.reason,
  re: new RegExp(w.source, "iu"),
}));

/**
 * Narrow phrases that share a word with a sensitive label and are not one. Each is removed from
 * the text before the words run, so anything else the label says still counts ("Library card
 * PIN" is still a PIN). They are phrases, never whole labels or word classes.
 */
export const POINTS_BENIGN_PHRASES: readonly string[] = [
  // A passport photo or scan is a file, not the number; "upload your passport number" is still a number.
  "passport[- ]?(?:photo|picture|image|scan|upload|copy|file|attachment)s?",
  "(?:upload|attach|scan)(?:ned|ed)?[- ]+(?:(?:your|a|an|the|of|my|copy|copies)[- ]+){0,3}passport(?![- ]*(?:number|no\\b|num\\b|#|id\\b))",
  // A card that is not a payment card: the same list the payment rule uses (an ID card number is an
  // identity number, so `id` stays out).
  `(?:${[...NOT_PAYMENT_CARD]
    .filter((w) => w !== "id")
    .concat(["boarding", "business"])
    .join("|")})[- ]?card(?:[- ]?(?:number|no|num))?`,
  // "Pass" as a thing that is not a password. A bare "Pass" is still a password.
  "\\bpass[- ]?(?:through|note|notes|fare|type|rate|count|date|holder|ticket|class|mark)\\b",
];
const BENIGN = POINTS_BENIGN_PHRASES.map((s) => new RegExp(s, "giu"));

const COMBINING_MARKS = /\p{M}+/gu;

/** NFKC, lower case, single spaces: how every rule here reads text. */
export function foldPointsText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function neutralise(text: string): string {
  let out = foldPointsText(text);
  for (const re of BENIGN) out = out.replace(re, " ");
  return out;
}

function stripAccents(text: string): string {
  return text.normalize("NFD").replace(COMBINING_MARKS, "").normalize("NFC");
}

/** The reason the words in some text mark a field sensitive, or `null`. */
function reasonOfText(raw: string, identifier?: string): Reason | null {
  if (raw === "" && (identifier ?? "") === "") return null;
  const text = neutralise(raw);
  const plain = stripAccents(text);
  const teach = classifyTeachField({ label: text, ...(identifier ? { name: identifier } : {}) });
  if (teach !== null) return teach;
  for (const w of POINTS_WORDS) if (w.re.test(text) || w.re.test(plain)) return w.reason;
  return null;
}

/**
 * Whether a page is one where Points gives directions only (§2.2): a payment or bank page, a host
 * a venue list knows, or a page served over plain `http:`. Every field on it counts as sensitive.
 */
export function classifyPointsPage(page: PointsPageFacts): "directions_only" | null {
  if (page.insecure === true) return "directions_only";
  if (page.url !== undefined && /^http:\/\//iu.test(page.url.trim())) return "directions_only";
  if (isMoneyContext({ url: page.url, title: page.title, hasPaymentFields: page.hasPaymentFields }))
    return "directions_only";
  if (venueOfHost(page.host ?? page.url) !== undefined) return "directions_only";
  return null;
}

/**
 * The reason a field is sensitive, or `null`. Decided from the field alone, before any value is
 * read. `page` is the result of `classifyPointsPage`: on a directions-only page every field is.
 */
export function classifyPointsField(
  f: PointsFieldFacts,
  page: "directions_only" | null = null,
): PointsSensitiveReason | null {
  if (f.secure === true) return "secure_field";
  if (page === "directions_only") return "directions_only";
  const own = [f.label, f.placeholder, f.help].filter((x): x is string => typeof x === "string");
  const direct = reasonOfText(own.join(" "), f.identifier);
  if (direct !== null) return direct;
  // The payment rule's own tokens (autocomplete `cc-*`, "credit card", "cvv"), as it reads them.
  if (
    isPaymentField({
      autocomplete: f.autocomplete,
      name: f.identifier,
      label: f.label,
      placeholder: f.placeholder,
    })
  )
    return "payment";
  if (f.autocomplete !== undefined) {
    const auto = classifyTeachField({ autocomplete: f.autocomplete });
    if (auto !== null) return auto;
  }
  // The group and sheet titles above the field and the static texts just before it.
  for (const ctx of [...(f.path ?? []), ...(f.nearbyText ?? [])]) {
    const r = reasonOfText(ctx);
    if (r !== null) return r;
  }
  return null;
}

/** An IBAN: country, two check digits, up to 30 alphanumerics, and a valid mod 97 check. */
function isIban(value: string): boolean {
  const s = value.replace(/[ -]/gu, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/u.test(s)) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const digits = ch >= "A" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** "ZIP code", "Postal code", "Area code": a short number next to "code" that is not a secret. */
const POSTAL_CODE_LABEL =
  /\b(?:zip|postal|post|area|country|dial(?:l)?ing|plz)[- ]?(?:code)?\b|郵便番号|邮政编码|邮编|우편번호|पिन कोड|الرمز البريدي/giu;

/**
 * A value that is a secret whatever field it is in: the teach value shapes (a Luhn card number,
 * `ddd-dd-dddd`, a token, a seed phrase, a bare code next to "code" or "pin"), an IBAN, and a
 * nine-digit run or spaced SSN. A hit drops the value and marks the field `value_shape`.
 */
export function classifyPointsValue(value: string, label = ""): PointsSensitiveReason | null {
  const teach = classifyTeachValue(value, label.replace(POSTAL_CODE_LABEL, " "));
  if (teach !== null) return teach;
  const v = value.trim();
  if (/\b[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}\b/u.test(v)) {
    for (const m of v.matchAll(/\b[A-Za-z]{2}\d{2}(?:[ -]?[A-Za-z0-9]){11,30}\b/gu))
      if (isIban(m[0])) return "payment";
  }
  if (/\b\d{3}[ .]\d{2}[ .]\d{4}\b/u.test(v)) return "identity";
  if (/^\d{9}$/u.test(v)) return "identity";
  return null;
}

/** What the card shows for a sensitive field (§3.3): a hint is allowed for identity fields only. */
export function pointsSelfFillPolicy(reason: PointsSensitiveReason): {
  /** One model hint of at most 100 characters, with no digit, may follow the fixed copy. */
  hint: boolean;
  /** The fixed copy names the field's label ("You fill this yourself: {label}"). */
  label: boolean;
} {
  return reason === "identity"
    ? { hint: true, label: true }
    : reason === "payment" || reason === "directions_only"
      ? { hint: false, label: false }
      : { hint: false, label: true };
}

// ---- Memory lines ----

export interface PointsMemoryLine {
  /** `memory:<id>` or `profile:<field>`. */
  id: string;
  text: string;
  /** From the owner's own words or a trusted recall chunk; never ingested or untrusted text. */
  trusted: boolean;
}

export type PointsMemoryRefusal =
  | "untrusted"
  | "bad_id"
  | "empty"
  | "sensitive_value"
  | "sensitive_kind";

const MEMORY_ID = /^(?:memory|profile):[A-Za-z0-9_.:-]{1,64}$/u;
/** Kinds Psyche never brings out of Memory, even when the owner told it (§3.3.3). */
const MEMORY_KIND_WORDS =
  /\b(?:ssn|social security|passport|credit|debit|card|account|iban|routing|pin|cvv|cvc|password|passcode|itin|licen[cs]e|secret|token|api key|seed phrase)\b/iu;

/** Whether one Memory line may go to the model: trusted, with an id, no sensitive value or kind. */
export function filterPointsMemoryLine(
  line: PointsMemoryLine,
): { ok: true; text: string } | { ok: false; reason: PointsMemoryRefusal } {
  if (!line.trusted) return { ok: false, reason: "untrusted" };
  if (!MEMORY_ID.test(line.id)) return { ok: false, reason: "bad_id" };
  const text = sanitizePointsValue(line.text);
  if (text === "") return { ok: false, reason: "empty" };
  if (classifyPointsValue(text) !== null) return { ok: false, reason: "sensitive_value" };
  const folded = neutralise(text);
  if (
    reasonOfText(text) !== null ||
    MEMORY_KIND_WORDS.test(folded) ||
    MEMORY_KIND_WORDS.test(stripAccents(folded))
  )
    return { ok: false, reason: "sensitive_kind" };
  return { ok: true, text };
}

export const POINTS_MEMORY_LINES_MAX = 12;
export const POINTS_MEMORY_CHARS_MAX = 1200;

/** The lines a plan call gets: filtered, then at most 12 lines and 1,200 characters in all. */
export function selectPointsMemoryLines(lines: readonly PointsMemoryLine[]): {
  kept: { id: string; text: string }[];
  dropped: { id: string; reason: PointsMemoryRefusal | "cap" }[];
} {
  const kept: { id: string; text: string }[] = [];
  const dropped: { id: string; reason: PointsMemoryRefusal | "cap" }[] = [];
  let chars = 0;
  for (const line of lines) {
    const r = filterPointsMemoryLine(line);
    if (!r.ok) {
      dropped.push({ id: line.id, reason: r.reason });
      continue;
    }
    if (kept.length >= POINTS_MEMORY_LINES_MAX || chars + r.text.length > POINTS_MEMORY_CHARS_MAX) {
      dropped.push({ id: line.id, reason: "cap" });
      continue;
    }
    kept.push({ id: line.id, text: r.text });
    chars += r.text.length;
  }
  return { kept, dropped };
}

// ---- Grounding ----

export type PointsDerivationRule = "exact" | "case" | "date_format" | "name_part" | "address_part";

export interface PointsGroundingSource {
  /** `goal`, `memory:<id>` or `profile:<field>`. */
  id: string;
  text: string;
}

export type PointsGrounding =
  | { ok: true; source: string }
  | {
      ok: false;
      reason: "no_value" | "no_source" | "unknown_source" | "sensitive_value" | "not_grounded";
    };

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

function tokens(text: string): string[] {
  return foldPointsText(text)
    .split(TOKEN_SPLIT)
    .filter((t) => t !== "");
}

/** `needle` occurs in `hay` starting and ending on a word edge ("Ann" is not in "Joanne"). */
function containsAtEdges(hay: string, needle: string): boolean {
  if (needle === "") return false;
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (hay[at - 1] ?? "");
    const after = hay[at + needle.length] ?? "";
    const first = needle[0] ?? "";
    const last = needle[needle.length - 1] ?? "";
    const edgeBefore = !/[\p{L}\p{N}]/u.test(first) || !/[\p{L}\p{N}]/u.test(before);
    const edgeAfter = !/[\p{L}\p{N}]/u.test(last) || !/[\p{L}\p{N}]/u.test(after);
    if (edgeBefore && edgeAfter) return true;
    from = at + 1;
  }
}

const MONTHS: Record<string, number> = {};
for (const [month, names] of Object.entries({
  1: "january jan enero ene janvier janv januar januari gennaio gen janeiro",
  2: "february feb febrero fevrier fevr februar febbraio fev fevereiro",
  3: "march mar marzo mars marz marco",
  4: "april apr abril avril aprile",
  5: "may mayo mai maggio maio mag",
  6: "june jun junio juin juni giugno junho giu",
  7: "july jul julio juillet juil juli luglio julho lug",
  8: "august aug agosto aout august ago",
  9: "september sep sept septiembre septembre settembre setembro set",
  10: "october oct octubre octobre oktober ottobre outubro ott out okt",
  11: "november nov noviembre novembre novembro",
  12: "december dec diciembre decembre dezember dicembre dezembro dic dez",
})) {
  for (const n of names.split(" ")) MONTHS[n] = Number(month);
}

interface ParsedDate {
  /** `YYYY-MM-DD` readings of it: one, or two for an ambiguous `03/04/1985`. */
  readings: Set<string>;
  /** The literal numeric pair of an ambiguous date: swapping day and month is a different date. */
  pair?: string;
  /** Where it sits in the folded, accent-free text. */
  span: [number, number];
}

function validDate(y: number, m: number, d: number): string | null {
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const MONTH_NAMES = Object.keys(MONTHS)
  .sort((x, y) => y.length - x.length)
  .join("|");

/** The text dates are read from: NFKC, lower case, accents removed. */
function dateText(text: string): string {
  return stripAccents(foldPointsText(text));
}

/** Every date a text states, in the forms owners and forms use. Two-digit years are not read. */
export function parsePointsDates(text: string): ParsedDate[] {
  const t = dateText(text);
  const out: ParsedDate[] = [];
  const push = (m: RegExpMatchArray, r: (string | null)[], pair?: string) => {
    const readings = new Set(r.filter((x): x is string => x !== null));
    const at = m.index ?? 0;
    const span: [number, number] = [at, at + m[0].length];
    if (readings.size > 0)
      out.push(pair === undefined ? { readings, span } : { readings, pair, span });
  };
  for (const m of t.matchAll(/(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/gu))
    push(m, [validDate(Number(m[1]), Number(m[2]), Number(m[3]))]);
  for (const m of t.matchAll(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日?/gu))
    push(m, [validDate(Number(m[1]), Number(m[2]), Number(m[3]))]);
  for (const m of t.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)/gu)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    const mdy = validDate(y, a, b);
    const dmy = validDate(y, b, a);
    push(m, [mdy, dmy], mdy !== null && dmy !== null && a !== b ? `${a}/${b}` : undefined);
  }
  for (const m of t.matchAll(
    new RegExp(
      `(?<![\\p{L}])(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`,
      "gu",
    ),
  ))
    push(m, [validDate(Number(m[3]), MONTHS[m[1] ?? ""] ?? 0, Number(m[2]))]);
  for (const m of t.matchAll(
    new RegExp(
      `(?<!\\d)(\\d{1,2})(?:\\.|st|nd|rd|th|\\u00ba)?\\s+(?:of\\s+|de\\s+|del\\s+)?(${MONTH_NAMES})\\.?,?\\s+(?:de\\s+|del\\s+)?(\\d{4})(?!\\d)`,
      "gu",
    ),
  ))
    push(m, [validDate(Number(m[3]), MONTHS[m[2] ?? ""] ?? 0, Number(m[1]))]);
  return out;
}

function dateGrounded(value: string, source: string): boolean {
  const vs = parsePointsDates(value);
  // The whole value is one date: "born 03/04/1985" is not a value.
  const v = vs[0];
  if (vs.length !== 1 || v === undefined) return false;
  const text = dateText(value);
  const rest = text.slice(0, v.span[0]) + text.slice(v.span[1]);
  if (rest.replace(/[\s,.\-/]/gu, "") !== "") return false;
  for (const s of parsePointsDates(source)) {
    // Two ambiguous numeric dates must be the same literal pair: day and month swapped is another date.
    if (v.pair !== undefined && s.pair !== undefined && v.pair !== s.pair) continue;
    for (const r of v.readings) if (s.readings.has(r)) return true;
  }
  return false;
}

function partsGrounded(value: string, source: string, kind: "name" | "address"): boolean {
  const have = tokens(source);
  const set = new Set(have);
  const want = tokens(value);
  if (want.length === 0) return false;
  return want.every((t) => {
    if (set.has(t)) return true;
    // A name initial ("J." for John) is the first letter of a token of the source.
    if (kind === "name" && t.length === 1 && /\p{L}/u.test(t))
      return have.some((h) => h.startsWith(t));
    return false;
  });
}

/**
 * Whether a suggested value traces to one of the sources the step cites, by the rule its
 * `derivation` names (default `exact`, the strictest):
 * - `exact`: the value is a substring of the source, on word edges, after NFKC and space folding;
 * - `case`: the same, ignoring case;
 * - `name_part`: every token of the value is a token of the source (an initial may stand for a name);
 * - `address_part`: every token of the value is a token of the source;
 * - `date_format`: the value is one date and equals a date the source states.
 * A value that fails is dropped by the caller. A value `classifyPointsValue` flags never grounds.
 */
export function groundPointsValue(
  step: {
    value: string | undefined;
    derivation?: PointsDerivationRule | undefined;
    sources?: readonly string[] | undefined;
  },
  available: readonly PointsGroundingSource[],
  label = "",
): PointsGrounding {
  const value = sanitizePointsValue(step.value ?? "");
  if (value === "") return { ok: false, reason: "no_value" };
  if (classifyPointsValue(value, label) !== null) return { ok: false, reason: "sensitive_value" };
  const cited = step.sources ?? [];
  if (cited.length === 0) return { ok: false, reason: "no_source" };
  const byId = new Map(available.map((s) => [s.id, s.text]));
  const texts = cited.map((id) => ({ id, text: byId.get(id) }));
  if (texts.every((t) => t.text === undefined)) return { ok: false, reason: "unknown_source" };
  const rule = step.derivation ?? "exact";
  const spaced = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  for (const { id, text } of texts) {
    if (text === undefined) continue;
    let ok = false;
    switch (rule) {
      case "exact":
        ok = containsAtEdges(text.normalize("NFKC").replace(/\s+/gu, " "), spaced);
        break;
      case "case":
        ok = containsAtEdges(foldPointsText(text), foldPointsText(spaced));
        break;
      case "name_part":
        ok = partsGrounded(spaced, text, "name");
        break;
      case "address_part":
        ok = partsGrounded(spaced, text, "address");
        break;
      case "date_format":
        ok = dateGrounded(spaced, text);
        break;
    }
    if (ok) return { ok: true, source: id };
  }
  return { ok: false, reason: "not_grounded" };
}

// ---- Sanitizer ----

/** Control and line-break characters become a space; format, private-use and lone surrogates vanish. */
const TO_SPACE = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const TO_NOTHING = /[\p{Cf}\p{Co}\p{Cs}]/gu;

function stripUnsafeChars(text: string): string {
  return text.replace(TO_SPACE, " ").replace(TO_NOTHING, "");
}

const EMAIL = /[^\s@<>()[\]"']+@[^\s@<>()[\]"']+\.[^\s@<>()[\]"']+/gu;
const URL_WITH_SCHEME = /\b[a-z][a-z0-9+.-]{1,20}:(?:\/\/|\\\\)\S+/giu;
const URL_SCHEME_ONLY = /\b(?:mailto|tel|sms|data|javascript|file|facetime|x-apple[a-z.-]*):\S*/giu;
const URL_WWW = /\bwww\.\S+/giu;
const URL_BARE =
  /\b(?:[a-z0-9-]+\.)+(?:com|org|net|gov|edu|io|co|us|uk|de|fr|es|it|jp|cn|kr|in|app|dev|info|biz|xyz|me|ly|to|ru|br|ca|au|nl|ch|se|no|eu|cc|tv|ai|ink|link|click|top|site|online|shop|store|page|cloud|tech)\b(?:[/:?#]\S*)?/giu;

/**
 * Model text as the card draws it: plain text. No control, format or bidi characters (NEL, LS,
 * PS, the bidi overrides and isolates, zero-width characters), no links or email addresses, no
 * Markdown or tags, one line, cut at `max` code points. Control characters go first and the
 * text is folded to NFKC before the link rules run, so `ht​tps://` and `ｈｔｔｐ：／／` do not slip by.
 */
export function sanitizePointsNote(text: string, max = 140): string {
  // Markdown line prefixes first, while the line breaks are still there.
  let t = text
    .split(/\r\n|\n|\r/u)
    .map((line) => line.replace(/^\s*(?:#{1,6}|>|[-*+])\s+/u, ""))
    .join(" ");
  t = stripUnsafeChars(t).normalize("NFKC");
  t = stripUnsafeChars(t);
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1");
  t = t.replace(EMAIL, " ").replace(URL_WITH_SCHEME, " ").replace(URL_SCHEME_ONLY, " ");
  t = t.replace(URL_WWW, " ").replace(URL_BARE, " ");
  t = t
    .replace(/<[^>\n]*>/gu, " ")
    .replace(/[*`~|]/gu, "")
    .replace(/_{2,}/gu, " ");
  t = t.replace(/\s+/gu, " ").trim();
  const chars = Array.from(t);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : t;
}

/**
 * The one model hint that may follow the fixed copy on an identity field, at most 100 characters.
 * It is dropped (`null`) if it holds any digit, in any script, so a number cannot ride in it.
 */
export function sanitizePointsHint(text: string): string | null {
  if (/\p{Nd}|\p{No}|\p{Nl}/u.test(text.normalize("NFKC"))) return null;
  const clean = sanitizePointsNote(text, 100);
  if (clean === "" || /\p{Nd}|\p{No}|\p{Nl}/u.test(clean)) return null;
  return clean;
}

/**
 * A suggested value as the card shows and the owner copies it: control, format and bidi characters
 * removed (no hidden text rides in a value), whitespace folded, at most 500 characters. It is not
 * rewritten otherwise: grounding judges what the owner would paste.
 */
export function sanitizePointsValue(text: string, max = 500): string {
  const t = stripUnsafeChars(text).replace(/\s+/gu, " ").trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join("") : t;
}
