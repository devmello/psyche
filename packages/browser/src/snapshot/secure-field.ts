import { isPaymentField } from "@psyche/protocol/money-intent";

/**
 * Which form controls hold a secret the model must never read: passwords, one-time codes, PINs
 * and card details. One classifier, three levels:
 *
 * - `legacy`: `type=password` or a secure `autocomplete`. Typing into such a field is refused
 *   (the agent may still type a code the owner gave it into any other field).
 * - `strong`: high-confidence names and labels. Masked everywhere; a filled one refuses
 *   screenshots and drops recording frames.
 * - `weak`: masked everywhere; refuses screenshots only when its value has the secret's shape
 *   (`shape`): 1-8 digits for codes, PINs and digit boxes, MM/YY for expiry, anything for `pan`.
 *
 * Names and labels are matched by lexicon in the ten shipped languages (ar, de, es, fr, hi, it,
 * ja, ko, pt, zh, plus English). Latin words match whole tokens; scripts without spaces match by
 * substring, minus known compounds ("암호화폐" is a cryptocurrency, not a password). Search fields
 * are never classified by their label.
 */

export interface FieldFacts {
  tag: string;
  type?: string | undefined;
  autocomplete?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  /** The accessible name (label) as the AX tree or the DOM gives it. */
  label?: string | undefined;
  contentEditable?: boolean | undefined;
  maxLength?: number | undefined;
  inputMode?: string | undefined;
  /** The control is a search box (`type=search`, `role=searchbox`). */
  search?: boolean | undefined;
  /** One of four or more sibling one-character inputs: a split OTP. */
  splitBox?: boolean | undefined;
}

export type SecureLevel = "legacy" | "strong" | "weak";
/** What a weak field's value must look like before it refuses screenshots. */
export type SecretShape = "digits" | "expiry" | "any";
export interface SecureClass {
  level: SecureLevel;
  /** Weak fields only. */
  shape?: SecretShape;
}

const SECURE_AUTOCOMPLETE =
  /^(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp(-month|-year)?)$/;

/** Input types that never hold typed text, so a name such as "card" on them means nothing. */
const NON_TEXT_TYPES = new Set([
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "image",
  "file",
  "hidden",
  "range",
  "color",
]);

const isAscii = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
};

const plain = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "");

/**
 * Lower-case words of an identifier, accents removed: camelCase, `OTPCode`, letter-to-digit
 * (`otp1`), `_`, `-` and `[]` split; zero-width characters dropped.
 */
export function norm(s: string): string {
  if (isAscii(s)) {
    return s
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
      .replace(/([A-Za-z])([0-9])/g, "$1 $2")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  return plain(
    s
      .normalize("NFKC")
      .replace(/\p{Cf}/gu, "")
      .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
      .replace(/(\p{L})(\p{N})/gu, "$1 $2")
      .toLowerCase(),
  )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const SPACED = /^[a-z0-9 ]+$/;

const tokensOf = (text: string): string[] => text.split(" ").filter((w) => w !== "");

/** A normalised text, its tokens and whether it is plain ASCII, computed once per field text. */
interface Txt {
  t: string;
  padded: string;
  toks: string[];
  ascii: boolean;
}
const txt = (t: string): Txt => ({ t, padded: ` ${t} `, toks: tokensOf(t), ascii: isAscii(t) });

/**
 * A term list, normalised once. Spaced (Latin) terms match whole words (one-word terms by token
 * lookup), others by substring.
 */
class Terms {
  readonly #words = new Set<string>();
  /** Spaced phrases (` one time code `) by their first word. */
  readonly #phrases = new Map<string, string[]>();
  readonly #other: string[] = [];
  constructor(terms: readonly string[]) {
    for (const raw of terms) {
      const t = norm(raw);
      if (t === "") continue;
      if (!SPACED.test(t)) this.#other.push(t);
      else if (t.includes(" ")) {
        const first = t.slice(0, t.indexOf(" "));
        const list = this.#phrases.get(first) ?? [];
        list.push(` ${t} `);
        this.#phrases.set(first, list);
      } else this.#words.add(t);
    }
  }
  in(x: Txt): boolean {
    for (const w of x.toks) {
      if (this.#words.has(w)) return true;
      const ps = this.#phrases.get(w);
      if (ps !== undefined) for (const t of ps) if (x.padded.includes(t)) return true;
    }
    // Every non-spaced term holds a non-ASCII character.
    if (!x.ascii) for (const t of this.#other) if (x.t.includes(t)) return true;
    return false;
  }
}

/** Compounds in scripts without word spaces that contain a secret word and are not one. */
const COMPOUNDS = [
  "암호화",
  "일회용품",
  "일회용컵",
  "일회용기",
  "密码学",
  "密碼學",
  "暗号資産",
  "暗号化",
].map(norm);
const unCompound = (x: Txt): Txt => {
  if (x.ascii) return x;
  let out = x.t;
  for (const c of COMPOUNDS) if (out.includes(c)) out = out.split(c).join(" ");
  return out === x.t ? x : txt(out);
};

/** Latin password words: a whole token, a token's prefix, or (6+ letters) its suffix. */
const PASSWORD_LATIN = [
  "password",
  "passwd",
  "passwort",
  "kennwort",
  "passphrase",
  "passcode",
  "contrasena",
  "senha",
  "motdepasse",
  "wachtwoord",
  "losenord",
];
const PASSWORD_OTHER = new Terms([
  "mot de passe",
  "palavra passe",
  "pass phrase",
  "pwd",
  "密码",
  "密碼",
  "パスワード",
  "비밀번호",
  "암호",
  "पासवर्ड",
  "كلمة المرور",
  "كلمة السر",
]);
/** A text that mentions a password without being one. */
const PASSWORD_EXCLUDE = new Terms([
  "hint",
  "hints",
  "forgot",
  "forgotten",
  "reset",
  "resets",
  "resetting",
  "changing",
  "why",
  "reason",
  "strength",
  "manager",
  "link",
  "requirements",
  "policy",
  "help",
  "tips",
  "passwordless",
  "search",
  "esqueci",
  "vergessen",
  "oublie",
  "olvide",
  "dimenticata",
  "indice",
  "pista",
  "dica",
  "hinweis",
  "提示",
  "ヒント",
  "힌트",
  "忘记",
  "忘記",
]);

function mentionsPassword(t: Txt): boolean {
  for (const tok of t.toks) {
    for (const w of PASSWORD_LATIN) {
      if (tok === w || tok.startsWith(w) || (w.length >= 6 && tok.endsWith(w))) return true;
    }
  }
  return PASSWORD_OTHER.in(unCompound(t));
}

/** "Clave" is a password or PIN in Latin-American banking, and a key or keyword elsewhere. */
const CLAVE_EXCLUDE = new Terms([
  "palabra",
  "palabras",
  "producto",
  "licencia",
  "registro",
  "elector",
  "curp",
  "rfc",
  "interbancaria",
  "catastral",
  "search",
  "buscar",
]);

/** One-time, verification, security and recovery codes; CVC and friends. */
const CODE_PHRASES = new Terms([
  "otp",
  "totp",
  "otc",
  "2fa",
  "mfa",
  "tfa",
  "one time code",
  "one time passcode",
  "one time password",
  "one time pin",
  "onetimecode",
  "verification code",
  "verificationcode",
  "verify code",
  "authentication code",
  "authenticator",
  "auth code",
  "authcode",
  "login code",
  "sms code",
  "email code",
  "security code",
  "securitycode",
  "approvals code",
  "two step code",
  "2 step code",
  "backup code",
  "backup codes",
  "backupcode",
  "recovery code",
  "recovery codes",
  "recoverycode",
  "cvc",
  "cvv",
  "cvv2",
  "cvc2",
  "cv2",
  "cvn",
  "csc",
  "cryptogramme",
  "card verification",
  "codigo de verificacion",
  "codigo de verificacao",
  "code de verification",
  "bestatigungscode",
  "verifizierungscode",
  "sicherheitscode",
  "prufnummer",
  "pruefnummer",
  "kartenprufnummer",
  "kartenpruefnummer",
  "prufziffer",
  "einmalcode",
  "einmalpasswort",
  "codice di verifica",
  "codice di sicurezza",
  "codice monouso",
  "codigo de seguridad",
  "codigo de seguranca",
  "code de securite",
  "codigo de un solo uso",
  "codigo de recuperacion",
  "clave dinamica",
  "wiederherstellungscode",
  "code de recuperation",
  "验证码",
  "驗證碼",
  "安全码",
  "安全碼",
  "动态码",
  "動態碼",
  "認証コード",
  "セキュリティコード",
  "ワンタイム",
  "인증번호",
  "인증 코드",
  "인증코드",
  "보안 코드",
  "보안코드",
  "일회용",
  "सत्यापन कोड",
  "वेरिफिकेशन कोड",
  "ओटीपी",
  "رمز التحقق",
  "كود التحقق",
  "رمز لمرة واحدة",
  "رمز الأمان",
]);
/** "Two-factor" and "two-step" are a code only beside a code word ("Two-factor phone" is not). */
const SECOND_FACTOR = new Terms(["two factor", "2 factor", "second factor", "two step", "2 step"]);
const CODE_WORDS = new Terms(["code", "codes", "token", "pin", "otp", "passcode", "key"]);
/** "6-digit code", "código de 6 dígitos". */
const N_DIGIT_CODE =
  /\b\d{1,2} (digit|digits|stellig|stelligen|chiffres?|digitos?|cifre) (\p{L}+ )?(code|codigo|codice|pin|passcode|otp)\b|\b(code|codigo|codice) (de |di |a )?\d{1,2} (digitos?|chiffres?|cifre|stellen)\b/u;

/** Card number words in the shipped languages (the shared `isPaymentField` rule adds more). */
const CARD_NUMBER_PHRASES = new Terms([
  "card number",
  "card num",
  "card no",
  "cardnumber",
  "cc number",
  "ccnumber",
  "kartennummer",
  "kreditkartennummer",
  "numero de carte",
  "numero de tarjeta",
  "numero do cartao",
  "numero della carta",
  "numero di carta",
  "卡号",
  "卡號",
  "银行卡号",
  "カード番号",
  "카드번호",
  "카드 번호",
  "कार्ड नंबर",
  "رقم البطاقة",
]);
/** A card word on something that is not the payment card (checked per text). */
const CARD_EXCLUDE = new Terms([
  "gift",
  "library",
  "loyalty",
  "membership",
  "student",
  "reward",
  "rewards",
  "nickname",
  "alias",
  "descriptor",
  "title",
  "sim",
  "id",
]);
const CARD_CONTEXT = new Terms([
  "card",
  "credit",
  "debit",
  "cc",
  "payment",
  "amex",
  "karte",
  "kreditkarte",
  "carte",
  "tarjeta",
  "cartao",
  "carta",
  "卡",
  "カード",
  "카드",
  "कार्ड",
  "البطاقة",
]);

/** Bare "code" is an OTP only with context, and never beside these. */
const BARE_CODE = new Terms(["code", "codigo", "codice", "kode"]);
const BARE_CODE_CONTEXT = new Terms([
  "enter",
  "sent",
  "send",
  "digit",
  "digits",
  "received",
  "text message",
  "ingresa",
  "introduzca",
  "introduce",
  "saisissez",
  "eingeben",
  "inserisci",
  "digite",
  "입력",
  "输入",
  "請輸入",
  "入力",
  "أدخل",
]);
const BARE_CODE_EXCLUDE = new Terms([
  "promo",
  "promotion",
  "coupon",
  "postal",
  "zip",
  "booking",
  "discount",
  "gift",
  "voucher",
  "confirmation",
  "reservation",
  "referral",
  "invite",
  "invitation",
  "country",
  "area",
  "product",
  "item",
  "sku",
  "source",
  "color",
  "colour",
  "cupon",
  "descuento",
  "promocional",
  "access",
  "tracking",
  "track",
  "class",
  "course",
  "html",
  "css",
  "embed",
  "snippet",
  "qr",
  "barcode",
  "shipping",
  "shipment",
  "parcel",
  "package",
  "order",
  "license",
  "licence",
  "serial",
  "activation",
  "redeem",
  "redemption",
  "event",
  "ticket",
  "join",
  "game",
  "language",
  "currency",
  "tax",
  "airport",
  "station",
  "branch",
  "bank",
  "sort",
  "swift",
  "routing",
]);
/** Pins on a map or a board, not a PIN. */
const PIN_EXCLUDE = new Terms([
  "title",
  "board",
  "location",
  "map",
  "drop",
  "address",
  "pinned",
  "pinterest",
  "comment",
  "note",
  "description",
  "post",
  "message",
]);

const EXPIRY_WORDS = ["expiry", "expiration", "expdate", "expirydate", "expirationdate"];
const EXPIRY_PHRASES = new Terms([
  "exp date",
  "expiry date",
  "expiration date",
  "date d expiration",
  "fecha de vencimiento",
  "fecha de caducidad",
  "fecha de expiracion",
  "vencimiento",
  "gultig bis",
  "gueltig bis",
  "ablaufdatum",
  "data di scadenza",
  "data de validade",
  "data de vencimento",
  "有效期",
  "有効期限",
  "유효기간",
  "समाप्ति तिथि",
  "تاريخ الانتهاء",
]);

const DIGIT_BOX_LABEL =
  /^(digit|character|char|dígito|chiffre|ziffer)\s*\d+(\s*(of|de|sur|von|\/)\s*\d+)?$/iu;
const DIGIT_BOX_NAME =
  /^(otp|code|digit|pin|passcode|character|char)( digit| character| char)? \d+( of \d+)?$/;

const PAYMENT_HINT = /card|cc|credit|debit|cvv|cvc|csc|security/i;

const hasAny = (words: readonly string[], list: readonly string[]): boolean =>
  words.some((w) => list.includes(w));

const STRONG: SecureClass = { level: "strong" };
const LEGACY: SecureClass = { level: "legacy" };
const weak = (shape: SecretShape): SecureClass => ({ level: "weak", shape });

/** The field's level, or undefined for an ordinary field. */
export function classifyField(f: FieldFacts): SecureClass | undefined {
  const tag = f.tag.toUpperCase();
  const type = (f.type ?? "").toLowerCase();
  const control =
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || f.contentEditable === true;
  if (!control) return undefined;
  if (tag === "INPUT" && type === "password") return LEGACY;
  const ac = (f.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (ac.some((t) => SECURE_AUTOCOMPLETE.test(t))) return LEGACY;
  const isInput = tag === "INPUT" && f.contentEditable !== true;
  const textual =
    tag === "TEXTAREA" ||
    f.contentEditable === true ||
    (tag === "INPUT" && !NON_TEXT_TYPES.has(type));
  if (!textual) return undefined;
  // A search box asks about passwords and codes; it does not hold one.
  if (f.search === true || type === "search") return undefined;
  if (f.splitBox === true && isInput) return STRONG;

  // Django ids are `id_<name>`: the "id" is not an ID card.
  const id = f.id?.replace(/^id[_-]/i, "");
  const normed = new Map<string | undefined, string>();
  const n = (t: string | undefined): string => {
    let v = normed.get(t);
    if (v === undefined) {
      v = t === undefined ? "" : norm(t);
      normed.set(t, v);
    }
    return v;
  };
  const texts = [f.name, id, f.ariaLabel, f.placeholder, f.label]
    .filter((t): t is string => typeof t === "string" && t !== "")
    .map((t) => txt(n(t)))
    .filter((t) => t.t !== "");
  if (texts.length === 0) return undefined;
  const all = txt(texts.map((t) => t.t).join(" "));
  const allWords = all.toks;

  // Passwords, including one revealed by a toggle (`type=text`).
  for (const t of texts) {
    if (mentionsPassword(t) && !PASSWORD_EXCLUDE.in(t)) return STRONG;
    if (t.toks.includes("clave") && !CLAVE_EXCLUDE.in(t)) return STRONG;
  }
  // One-time, verification, security and recovery codes; CVC.
  for (const t of texts) {
    const u = unCompound(t);
    if (CODE_PHRASES.in(u)) return STRONG;
    if (SECOND_FACTOR.in(t) && CODE_WORDS.in(t)) return STRONG;
    if (N_DIGIT_CODE.test(t.t) && !BARE_CODE_EXCLUDE.in(t)) return STRONG;
  }
  // CID is a card code only beside a card word (else it is a customer or campaign ID).
  if (allWords.includes("cid") && (CARD_CONTEXT.in(all) || allWords.includes("security"))) {
    return STRONG;
  }
  // Card numbers: the shared rule and the lexicon, unless that text names some other card.
  const raw = [f.name, id, f.label ?? f.ariaLabel, f.placeholder];
  for (const [i, t] of raw.entries()) {
    if (t === undefined || t === "") continue;
    const x = txt(n(t));
    if (CARD_EXCLUDE.in(x)) continue;
    if (CARD_NUMBER_PHRASES.in(x)) return STRONG;
    // Every `isPaymentField` pattern holds one of these words.
    if (!PAYMENT_HINT.test(t)) continue;
    const one = { name: i === 0 ? t : undefined, id: i === 1 ? t : undefined };
    if (
      isPaymentField({
        ...one,
        label: i === 2 ? t : undefined,
        placeholder: i === 3 ? t : undefined,
      })
    ) {
      return STRONG;
    }
  }
  if (f.ariaLabel !== undefined && f.label !== undefined) {
    const x = txt(n(f.ariaLabel));
    if (!CARD_EXCLUDE.in(x) && CARD_NUMBER_PHRASES.in(x)) return STRONG;
  }

  // "PIN code" / `pincode` is an Indian postal code unless it is 4 digits long.
  const postalPin =
    (allWords.includes("pincode") || (allWords.includes("pin") && allWords.includes("code"))) &&
    !(f.maxLength !== undefined && f.maxLength <= 4);
  const codeish = BARE_CODE.in(all) || allWords.includes("pin");
  // A code field whose placeholder is a sample code ("123456").
  if (
    isInput &&
    codeish &&
    !postalPin &&
    /^\d{4,8}$/.test((f.placeholder ?? "").replace(/[\s-]/g, "")) &&
    !BARE_CODE_EXCLUDE.in(all)
  ) {
    return STRONG;
  }

  // Weaker signals: masked in snapshots and text; screenshots only for a secret-shaped value.
  const idWords = [...tokensOf(n(f.name)), ...tokensOf(n(id))];
  if (hasAny(idWords, ["pan"])) return weak("any");
  if (/\d{4}[ -]\d{4}[ -]\d{4}/.test(f.placeholder ?? "")) return weak("any");
  // Expiry: an expiry word or phrase, an MM/YY placeholder, or `exp` beside a card word.
  if (
    hasAny(allWords, EXPIRY_WORDS) ||
    texts.some((t) => EXPIRY_PHRASES.in(t)) ||
    /^\s*m{1,2}\s*[/-]\s*(y{2}|y{4}|a{2}|a{4}|j{2}|j{4})\s*$/i.test(f.placeholder ?? "") ||
    (hasAny(idWords, ["exp"]) && CARD_CONTEXT.in(all))
  ) {
    return weak("expiry");
  }
  // Split OTP boxes ("Digit 1", `code1`, `pin-1`).
  if (
    [f.label, f.ariaLabel].some((t) => DIGIT_BOX_LABEL.test((t ?? "").trim())) ||
    texts.some((t) => DIGIT_BOX_NAME.test(t.t))
  ) {
    return weak("digits");
  }
  // Bare "code" and PIN: single-line inputs only (a `<textarea name=code>` is a code editor).
  const longField = f.maxLength !== undefined && f.maxLength > 12;
  if (!isInput || longField) return undefined;
  // PIN is secret unless it reads as a postal code ("PIN code", `pincode`) or a map / board pin.
  if (hasAny(allWords, ["pin", "geheimzahl", "geheimnummer"]) && !postalPin) {
    if (!PIN_EXCLUDE.in(all)) return weak("digits");
  }
  // Bare "code": an OTP beside "enter" / "sent" / "digit", or a field named just code.
  if (!BARE_CODE_EXCLUDE.in(all) && BARE_CODE.in(all)) {
    const named = texts.some(
      (t) => t.t === "code" || t.t === "codigo" || t.t === "codice" || t.t === "kode",
    );
    if (named || BARE_CODE_CONTEXT.in(all)) return weak("digits");
  }
  return undefined;
}

export const secureLevel = (f: FieldFacts): SecureLevel | undefined => classifyField(f)?.level;

/** `type=password` or a secure `autocomplete`: what typing is refused on. */
export function isLegacySecure(f: FieldFacts): boolean {
  return classifyField(f)?.level === "legacy";
}

/** All three levels: values are masked in snapshots, page text and `find`. */
export function isSecureField(f: FieldFacts): boolean {
  return classifyField(f) !== undefined;
}

/** Legacy and strong: a filled one refuses screenshots whatever its value looks like. */
export function isStrongSecureField(f: FieldFacts): boolean {
  const l = classifyField(f)?.level;
  return l === "legacy" || l === "strong";
}

// --- values ----------------------------------------------------------------------------------

/** NFKC-folded, zero-width characters removed, trimmed: how values are compared. */
export function foldValue(v: string): string {
  return v
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .trim();
}

/** The value looks like the secret a weak field of this shape holds. */
export function valueHasShape(shape: SecretShape | undefined, value: string): boolean {
  const v = foldValue(value);
  if (v === "") return false;
  switch (shape) {
    case "any":
      return true;
    case "digits":
      return /^\d{1,8}$/.test(v.replace(/[\s.\-/]/g, ""));
    case "expiry":
      return /^(0?[1-9]|1[0-2])\s*[/\-.]?\s*(\d{2}|\d{4})$/.test(v);
    default:
      return false;
  }
}

/** A filled field of this class refuses screenshots (legacy and strong always, weak by shape). */
export function blocksScreenshot(c: SecureClass | undefined, value: string): boolean {
  if (c === undefined) return false;
  if (c.level !== "weak") return true;
  return valueHasShape(c.shape, value);
}

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** The whole value is a payment card number (13-19 digits, Luhn-valid, separators allowed). */
export function isCardNumberValue(v: string): boolean {
  const f = foldValue(v);
  if (f.length > 40 || !/^[\d\s.\-/]+$/.test(f)) return false;
  const digits = f.replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhn(digits);
}

// --- the scrubber ------------------------------------------------------------------------------

/**
 * Separators a page may put inside a number or code: whitespace, `.`, `-`, `/`, dashes, middle
 * dots, their fullwidth forms, and zero-width / format characters (`\p{Cf}`).
 */
const SEP = "[\\s.\\-/\\u2010-\\u2015\\u2212\\u00b7\\u30fb\\uff0d\\uff0e\\uff0f\\p{Cf}]";
const SEP_ONE = new RegExp(`^${SEP}$`, "u");
const CF = /^\p{Cf}$/u;
/** ASCII digits, fullwidth, Arabic-Indic, extended Arabic-Indic and Devanagari digits. */
const DIGIT = "[0-9\\uff10-\\uff19\\u0660-\\u0669\\u06f0-\\u06f9\\u0966-\\u096f]";
/** 13 or more digits, at most six separator characters between two of them. */
const CARD_RUN = new RegExp(`${DIGIT}(?:${SEP}{0,6}${DIGIT}){12,}`, "gu");

function asciiDigit(cp: number): number {
  if (cp >= 48 && cp <= 57) return cp - 48;
  if (cp >= 0xff10 && cp <= 0xff19) return cp - 0xff10;
  if (cp >= 0x660 && cp <= 0x669) return cp - 0x660;
  if (cp >= 0x6f0 && cp <= 0x6f9) return cp - 0x6f0;
  if (cp >= 0x966 && cp <= 0x96f) return cp - 0x966;
  return -1;
}

/**
 * Card numbers inside one candidate run: the run is split into digit groups at separators, and
 * the longest Luhn-valid window of 13-19 digits from each group on is masked. A window is one
 * block, or groups of 3+ digits ("4242 4242 …", "3782 822463 10005"), so a row of small numbers
 * is not read as a card.
 */
function cardSpansIn(text: string, from: number, to: number, out: [number, number][]): void {
  const groups: { a: number; b: number; d: string }[] = [];
  let cur: { a: number; b: number; d: string } | undefined;
  let sep = false;
  for (let i = from; i < to; ) {
    const cp = text.codePointAt(i) ?? 0;
    const w = cp > 0xffff ? 2 : 1;
    const d = asciiDigit(cp);
    if (d >= 0) {
      if (cur === undefined || sep) {
        cur = { a: i, b: i + w, d: "" };
        groups.push(cur);
      }
      cur.d += String(d);
      cur.b = i + w;
      sep = false;
    } else if (!CF.test(text.slice(i, i + w))) sep = true;
    i += w;
  }
  for (let a = 0; a < groups.length; ) {
    let found = -1;
    let digits = "";
    for (let b = a; b < groups.length; b++) {
      const g = groups[b] as { a: number; b: number; d: string };
      if (b > a && (g.d.length < 3 || (groups[a] as { d: string }).d.length < 3)) break;
      digits += g.d;
      if (digits.length > 19) break;
      if (digits.length >= 13 && luhn(digits)) found = b;
    }
    if (found >= 0) {
      out.push([(groups[a] as { a: number }).a, (groups[found] as { b: number }).b]);
      a = found + 1;
    } else a++;
  }
}

/** A cap on tracked secret values: above it the page is treated as all-secret (fail closed). */
export const MAX_SECRETS = 64;

export interface Scrubber {
  /** Mask secret values (separators, zero-width and fullwidth forms ignored) and card numbers. */
  scrub(text: string): string;
  /** Text spans `[start, end)` that `scrub` masks. */
  spans(text: string): [number, number][];
}

const hex = (cp: number): string => `\\u{${cp.toString(16)}}`;

/** One character of a secret as a class: itself, its fullwidth form, other digit scripts. */
function charClass(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  const alts = [cp];
  if (cp >= 0x21 && cp <= 0x7e) alts.push(cp + 0xfee0);
  if (cp >= 48 && cp <= 57) alts.push(0x660 + cp - 48, 0x6f0 + cp - 48, 0x966 + cp - 48);
  return alts.length === 1 ? hex(cp) : `[${alts.map(hex).join("")}]`;
}

/**
 * A secret as a pattern: its folded characters with up to four separators between any two, and
 * no digit glued on at a digit end ("1234" is not masked inside "12345").
 */
function secretPattern(value: string): string | undefined {
  const chars = [...foldValue(value)].filter((c) => !SEP_ONE.test(c));
  if (chars.length < 4) return undefined;
  const head = asciiDigit(chars[0]?.codePointAt(0) ?? 0) >= 0 ? `(?<!${DIGIT})` : "";
  const tail = asciiDigit(chars[chars.length - 1]?.codePointAt(0) ?? 0) >= 0 ? `(?!${DIGIT})` : "";
  return `${head}${chars.map(charClass).join(`${SEP}{0,4}`)}${tail}`;
}

/**
 * Secret values (4+ characters once folded) become one combined pattern, matched in a single
 * pass over the text; card numbers are found by one candidate scan and checked with Luhn.
 */
export function makeScrubber(values: Iterable<string>, mask: string): Scrubber {
  const pats = [...new Set(values)]
    .map(secretPattern)
    .filter((p): p is string => p !== undefined)
    .sort((a, b) => b.length - a.length);
  const re = pats.length === 0 ? undefined : new RegExp(pats.join("|"), "gu");
  const spans = (text: string): [number, number][] => {
    const found: [number, number][] = [];
    if (re !== undefined) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        if (m[0] === "") re.lastIndex++;
        else found.push([m.index, m.index + m[0].length]);
      }
    }
    CARD_RUN.lastIndex = 0;
    for (let m = CARD_RUN.exec(text); m !== null; m = CARD_RUN.exec(text)) {
      cardSpansIn(text, m.index, m.index + m[0].length, found);
    }
    if (found.length === 0) return found;
    found.sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const [a, b] of found) {
      const last = out[out.length - 1];
      if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  };
  return {
    spans,
    scrub(text: string): string {
      const sp = spans(text);
      if (sp.length === 0) return text;
      let out = "";
      let pos = 0;
      for (const [a, b] of sp) {
        out += text.slice(pos, a) + mask;
        pos = b;
      }
      return out + text.slice(pos);
    },
  };
}

const CARDS_ONLY = new Map<string, Scrubber>();

/** Replace every Luhn-valid 13-19 digit run in free text (separators and digit forms folded). */
export function maskCardNumbers(text: string, mask: string): string {
  let s = CARDS_ONLY.get(mask);
  if (s === undefined) {
    s = makeScrubber([], mask);
    CARDS_ONLY.set(mask, s);
  }
  return s.scrub(text);
}
