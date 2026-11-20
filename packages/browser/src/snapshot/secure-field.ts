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
  /** The field was `type=password` earlier in this document (a reveal toggle made it text). */
  wasPassword?: boolean | undefined;
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
/**
 * Phrases that mention a password without being one ("Password hint", "Forgot your password?").
 * They are cut out of the text, and the field is a password only if a password word remains:
 * "Password Forgot your password?" (a label wrapping its own help link) still is one.
 */
const PW = ["password", "passwords", "passwort", "kennwort", "passcode", "senha", "contrasena"];
const PASSWORD_NOT: string[] = [
  "passwordless",
  ...PW.flatMap((w) => [
    `${w} hint`,
    `${w} hints`,
    `forgot ${w}`,
    `forgot your ${w}`,
    `forgot my ${w}`,
    `forgotten ${w}`,
    `forgotten your ${w}`,
    `reset ${w}`,
    `reset your ${w}`,
    `resetting your ${w}`,
    `${w} reset`,
    `${w} resets`,
    `${w} resetting`,
    `changing ${w}`,
    `changing your ${w}`,
    `${w} strength`,
    `${w} requirements`,
    `${w} policy`,
    `${w} rules`,
    `${w} tips`,
    `${w} manager`,
  ]),
  "mot de passe oublie",
  "indice de mot de passe",
  "esqueci minha senha",
  "esqueci a senha",
  "esqueceu sua senha",
  "dica de senha",
  "passwort vergessen",
  "kennwort vergessen",
  "passwort hinweis",
  "olvide mi contrasena",
  "olvidaste tu contrasena",
  "pista de contrasena",
  "password dimenticata",
  "hai dimenticato la password",
  "忘记密码",
  "忘記密碼",
  "密码提示",
  "密碼提示",
  "パスワードを忘れ",
  "パスワードのヒント",
  "비밀번호 찾기",
  "비밀번호를 잊",
  "비밀번호 힌트",
].map(norm);

function stripPasswordMentions(t: Txt): Txt {
  let padded = t.padded;
  for (const p of PASSWORD_NOT) {
    if (SPACED.test(p)) {
      const q = ` ${p} `;
      while (padded.includes(q)) padded = padded.split(q).join("  ");
    } else if (padded.includes(p)) padded = padded.split(p).join(" ");
  }
  const out = padded.replace(/ +/g, " ").trim();
  return out === t.t ? t : txt(out);
}

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
  "instrument",
  "instrumento",
  "music",
  "musica",
  "ritmo",
  "percussion",
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
/** A code word, and words that say the code was sent to the owner. */
const CODE_WORD = new Terms(["code", "codes", "codigo", "codice", "kode", "passcode", "pin"]);
const SENT = new Terms([
  "sent",
  "texted",
  "emailed",
  "text message",
  "sms",
  "enviado",
  "enviamos",
  "envoye",
  "gesendet",
  "inviato",
  "enviamos",
  "发送",
  "送信",
  "전송",
  "भेजा",
  "أرسلنا",
]);
/** Codes that are never an OTP, even "sent": promo, referral, invite, gift, captcha… */
const CODE_NOT_OTP = new Terms([
  "promo",
  "promotion",
  "promotional",
  "coupon",
  "cupon",
  "discount",
  "descuento",
  "voucher",
  "gift",
  "referral",
  "invite",
  "invitation",
  "postal",
  "zip",
  "product",
  "sku",
  "tracking",
  "track",
  "shipment",
  "parcel",
  "captcha",
  "image",
  "picture",
  "shown",
  "displayed",
  "tv",
  "class",
  "game",
]);
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
  "captcha",
  "image",
  "picture",
  "shown",
  "displayed",
  "tv",
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
  "game",
  "repository",
  "repo",
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
  // A reveal toggle turned this password field into text: it is still the password.
  if (f.wasPassword === true) return LEGACY;

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
    if (mentionsPassword(t) && mentionsPassword(stripPasswordMentions(t))) return STRONG;
    if (t.toks.includes("clave") && !CLAVE_EXCLUDE.in(t)) return STRONG;
  }
  // One-time, verification, security and recovery codes; CVC.
  for (const t of texts) {
    const u = unCompound(t);
    if (CODE_PHRASES.in(u)) return STRONG;
    if (SECOND_FACTOR.in(t) && CODE_WORDS.in(t)) return STRONG;
    // "6-digit code", "the code we sent": an OTP, even beside "bank", "order" or "access".
    if ((N_DIGIT_CODE.test(t.t) || (CODE_WORD.in(t) && SENT.in(t))) && !CODE_NOT_OTP.in(all)) {
      return STRONG;
    }
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
  // `pan` alone or beside a card or number word (not `pan_size`, `pan_x`).
  if (
    hasAny(idWords, ["pan"]) &&
    (idWords.every((w) => w === "pan") ||
      CARD_CONTEXT.in(all) ||
      hasAny(allWords, ["number", "num", "no", "nr"]))
  ) {
    return weak("any");
  }
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
      // Any decimal digit script (Arabic-Indic, Bengali…) counts, separators ignored.
      return /^\d{1,8}$/.test(foldedSecret(v));
    case "expiry":
      return /^(0?[1-9]|1[0-2])(\d{2}|\d{4})$/.test(foldedSecret(v));
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
  if (v.length > 64) return false;
  const digits = foldedSecret(v);
  return /^\d{13,19}$/.test(digits) && luhn(digits);
}

// --- the scrubber ------------------------------------------------------------------------------

/**
 * Text folded once into a canonical form for matching: NFKC, every decimal digit (`\p{Nd}`:
 * fullwidth, mathematical, Arabic-Indic, Bengali, Devanagari…) as ASCII, zero-width and format
 * characters (`\p{Cf}`) dropped, separators dropped. Separators are whitespace, `.`, `-`, `/`,
 * `|`, `_`, `,`, dashes and middle dots (and their fullwidth forms). `at[i]`/`end[i]` map folded
 * character `i` back to the original text; `seps[i]` counts the separators just before it.
 * No pattern is ever built from page values: matching is Aho-Corasick over this string.
 */
interface Folded {
  s: string;
  at: Int32Array;
  end: Int32Array;
  seps: Uint16Array;
}

const SEP_ASCII = new Uint8Array(128);
for (const c of "\t\n\v\f\r .-/|_,") SEP_ASCII[c.charCodeAt(0)] = 1;
const SEP_OTHER = /^[\s‐-―−·・，－．／＿｜]$/u;
const CF = /^\p{Cf}$/u;
const ND = /^\p{Nd}$/u;

/** Folded form of one non-ASCII code point: "" dropped, "\u0000" a separator, else the text. */
const FOLD_CACHE = new Map<number, string>();
function foldCodePoint(cp: number): string {
  const hit = FOLD_CACHE.get(cp);
  if (hit !== undefined) return hit;
  const ch = String.fromCodePoint(cp);
  let out: string;
  if (CF.test(ch)) out = "";
  else if (SEP_OTHER.test(ch)) out = "\u0000";
  else if (ND.test(ch)) out = String(digitValue(cp));
  else {
    out = "";
    for (const f of ch.normalize("NFKC")) {
      const c = f.charCodeAt(0);
      if (c < 128 ? SEP_ASCII[c] === 1 : SEP_OTHER.test(f)) out += "\u0000";
      else out += f;
    }
  }
  if (FOLD_CACHE.size > 8192) FOLD_CACHE.clear();
  FOLD_CACHE.set(cp, out);
  return out;
}

/** The value of a `\p{Nd}` digit: NFKC where it folds, else its place in its run of ten. */
function digitValue(cp: number): number {
  const n = String.fromCodePoint(cp).normalize("NFKC");
  if (n.length === 1 && n >= "0" && n <= "9") return n.charCodeAt(0) - 48;
  let k = 0;
  while (k < 9 && ND.test(String.fromCodePoint(cp - k - 1))) k++;
  return k % 10;
}

/** Scratch buffers shared by every `fold` call (synchronous, so never in use twice at once). */
let BUF = {
  cap: 0,
  codes: new Uint16Array(0),
  at: new Int32Array(0),
  end: new Int32Array(0),
  seps: new Uint16Array(0),
};
function ensure(cap: number): void {
  if (BUF.cap >= cap) return;
  const c = Math.max(cap, BUF.cap * 2, 1024);
  const next = {
    cap: c,
    codes: new Uint16Array(c),
    at: new Int32Array(c),
    end: new Int32Array(c),
    seps: new Uint16Array(c),
  };
  next.codes.set(BUF.codes);
  next.at.set(BUF.at);
  next.end.set(BUF.end);
  next.seps.set(BUF.seps);
  BUF = next;
}

/** The fold of `text`; its arrays are views of the shared buffers, valid until the next call. */
function fold(text: string): Folded {
  const n = text.length;
  ensure(n + 8);
  let len = 0;
  let sep = 0;
  const push = (code: number, from: number, to: number) => {
    if (len >= BUF.cap) ensure(len + 1);
    BUF.codes[len] = code;
    BUF.at[len] = from;
    BUF.end[len] = to;
    BUF.seps[len] = sep > 65535 ? 65535 : sep;
    sep = 0;
    len++;
  };
  for (let i = 0; i < n; ) {
    const c = text.charCodeAt(i);
    if (c < 128) {
      if (SEP_ASCII[c] === 1) sep++;
      else push(c, i, i + 1);
      i++;
      continue;
    }
    const cp = text.codePointAt(i) ?? c;
    const w = cp > 0xffff ? 2 : 1;
    const f = foldCodePoint(cp);
    for (let k = 0; k < f.length; k++) {
      const fc = f.charCodeAt(k);
      if (fc === 0) sep++;
      else push(fc, i, i + w);
    }
    i += w;
  }
  let s = "";
  for (let i = 0; i < len; i += 8192) {
    s += String.fromCharCode(...BUF.codes.subarray(i, Math.min(len, i + 8192)));
  }
  return {
    s,
    at: BUF.at.subarray(0, len),
    end: BUF.end.subarray(0, len),
    seps: BUF.seps.subarray(0, len),
  };
}

/** A pure-ASCII text with fewer than 13 digits holds no card number and needs no fold. */
function asciiFewDigits(text: string): boolean {
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 128) return false;
    if (c >= 48 && c <= 57 && ++digits >= 13) return false;
  }
  return true;
}

/** A value in folded form, separators removed (what the scrubber looks for). */
export function foldedSecret(value: string): string {
  return fold(value).s;
}

/** Aho-Corasick over UTF-16 units; reports, per end position, the longest pattern ending there. */
class Matcher {
  readonly #next: Map<number, number>[] = [new Map()];
  readonly #fail: number[] = [0];
  readonly #out: number[] = [0];
  readonly size: number;
  constructor(patterns: readonly string[]) {
    for (const p of patterns) {
      let node = 0;
      for (let i = 0; i < p.length; i++) {
        const c = p.charCodeAt(i);
        let nx = this.#next[node]?.get(c);
        if (nx === undefined) {
          nx = this.#next.length;
          this.#next.push(new Map());
          this.#fail.push(0);
          this.#out.push(0);
          this.#next[node]?.set(c, nx);
        }
        node = nx;
      }
      this.#out[node] = Math.max(this.#out[node] ?? 0, p.length);
    }
    this.size = patterns.length;
    const queue: number[] = [];
    for (const nx of this.#next[0]?.values() ?? []) queue.push(nx);
    for (let qi = 0; qi < queue.length; qi++) {
      const node = queue[qi] as number;
      for (const [c, nx] of this.#next[node] ?? []) {
        let f = this.#fail[node] ?? 0;
        while (f !== 0 && !this.#next[f]?.has(c)) f = this.#fail[f] ?? 0;
        const g = this.#next[f]?.get(c);
        const fl = g !== undefined && g !== nx ? g : 0;
        this.#fail[nx] = fl;
        this.#out[nx] = Math.max(this.#out[nx] ?? 0, this.#out[fl] ?? 0);
        queue.push(nx);
      }
    }
  }
  /** `onMatch(endInclusive, length)` for the longest pattern ending at each position. */
  search(s: string, onMatch: (end: number, len: number) => void): void {
    let node = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      while (node !== 0 && !this.#next[node]?.has(c)) node = this.#fail[node] ?? 0;
      node = this.#next[node]?.get(c) ?? 0;
      const len = this.#out[node] ?? 0;
      if (len > 0) onMatch(i, len);
    }
  }
}

const isDigitCode = (c: number): boolean => c >= 48 && c <= 57;

/** Card numbers: digit groups split at separators, at most six separator characters apart. */
function cardSpans(f: Folded, out: [number, number][]): void {
  const s = f.s;
  let i = 0;
  while (i < s.length) {
    if (!isDigitCode(s.charCodeAt(i))) {
      i++;
      continue;
    }
    const groups: [number, number][] = [];
    let g = i;
    let j = i + 1;
    for (; j < s.length && isDigitCode(s.charCodeAt(j)) && (f.seps[j] ?? 0) <= 6; j++) {
      if ((f.seps[j] ?? 0) > 0) {
        groups.push([g, j - 1]);
        g = j;
      }
    }
    groups.push([g, j - 1]);
    if (j - i >= 13) {
      for (let a = 0; a < groups.length; ) {
        const [ga, gaEnd] = groups[a] as [number, number];
        let found = -1;
        let total = 0;
        for (let b = a; b < groups.length; b++) {
          const [gb, gbEnd] = groups[b] as [number, number];
          // One block, or groups of 3+ digits ("4242 4242 …", "3782 822463 10005").
          if (b > a && (gbEnd - gb < 2 || gaEnd - ga < 2)) break;
          total += gbEnd - gb + 1;
          if (total > 19) break;
          if (total >= 13 && luhn(s.slice(ga, gbEnd + 1))) found = b;
        }
        if (found >= 0) {
          out.push([ga, (groups[found] as [number, number])[1]]);
          a = found + 1;
        } else a++;
      }
    }
    i = j;
  }
}

/** Fail closed: every run of 4+ digits (separators allowed, as for cards). */
function digitRunSpans(f: Folded, out: [number, number][]): void {
  const s = f.s;
  let i = 0;
  while (i < s.length) {
    if (!isDigitCode(s.charCodeAt(i))) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < s.length && isDigitCode(s.charCodeAt(j)) && (f.seps[j] ?? 0) <= 6) j++;
    if (j - i >= 4) out.push([i, j - 1]);
    i = j;
  }
}

/** Tracked secret values: at most this many, each at most `MAX_SECRET_CHARS` folded. */
export const MAX_SECRETS = 256;
export const MAX_SECRET_CHARS = 256;

export interface Scrubber {
  /** Mask secret values (separators, zero-width and other digit forms ignored) and card numbers. */
  scrub(text: string): string;
  /** Text spans `[start, end)` that `scrub` masks, sorted and merged. */
  spans(text: string): [number, number][];
}

const MAY_HOLD_DIGITS = /\p{Nd}/u;

/**
 * Masks known secret values and card numbers in one pass over the folded text. `failClosed`
 * (more secrets than are tracked) masks every run of four or more digits instead of the values.
 */
export function makeScrubber(
  values: Iterable<string>,
  mask: string,
  options: { failClosed?: boolean } = {},
): Scrubber {
  const keys = [...new Set([...values].map(foldedSecret))].filter(
    (k) => k.length >= 4 && k.length <= MAX_SECRET_CHARS,
  );
  const matcher = keys.length === 0 ? undefined : new Matcher(keys);
  const failClosed = options.failClosed === true;
  const spans = (text: string): [number, number][] => {
    if (
      matcher === undefined &&
      (failClosed
        ? !MAY_HOLD_DIGITS.test(text)
        : asciiFewDigits(text) || !MAY_HOLD_DIGITS.test(text))
    )
      return [];
    const f = fold(text);
    const found: [number, number][] = [];
    matcher?.search(f.s, (b, len) => {
      const a = b - len + 1;
      // Not inside a longer number: "1234" is not masked in "12345".
      const glued =
        (a > 0 &&
          f.seps[a] === 0 &&
          isDigitCode(f.s.charCodeAt(a)) &&
          isDigitCode(f.s.charCodeAt(a - 1))) ||
        (b + 1 < f.s.length &&
          f.seps[b + 1] === 0 &&
          isDigitCode(f.s.charCodeAt(b)) &&
          isDigitCode(f.s.charCodeAt(b + 1)));
      if (!glued) found.push([a, b]);
    });
    cardSpans(f, found);
    if (failClosed) digitRunSpans(f, found);
    if (found.length === 0) return [];
    found.sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const [a, b] of found) {
      const from = f.at[a] ?? 0;
      const to = f.end[b] ?? from;
      const last = out[out.length - 1];
      if (last !== undefined && from <= last[1]) last[1] = Math.max(last[1], to);
      else out.push([from, to]);
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
