import { isPaymentField } from "@psyche/protocol/money-intent";

/**
 * Which form controls hold a secret the model must never read: passwords, one-time codes, PINs
 * and card details. One classifier, three questions:
 *
 * - `isLegacySecure`: `type=password` or a secure `autocomplete`. Typing into such a field is
 *   refused (the agent may still type a code the owner gave it into any other field).
 * - `isSecureField`: the wide set. Its values are masked in snapshots, `read_text` and `find`.
 * - `isStrongSecureField`: the high-confidence subset. Only these refuse screenshots and drop
 *   recording frames, so a false positive ("Confirmation code") costs a masked value, not the
 *   screenshot tool.
 *
 * Names and labels are matched by lexicon in the ten shipped languages (ar, de, es, fr, hi, it,
 * ja, ko, pt, zh, plus English). Search fields are never classified by their label.
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
  /** The control is a search box (`type=search`, `role=searchbox`). */
  search?: boolean | undefined;
}

export type SecureLevel = "legacy" | "strong" | "weak";

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

const plain = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "");

/** Lower-case words of an identifier (camelCase, `_`, `-`, `[]` split), accents removed. */
function norm(s: string): string {
  return plain(
    s
      .normalize("NFKC")
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
      .toLowerCase(),
  )
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const SPACED = /^[a-z0-9 ]+$/;

function termIn(joined: string, term: string): boolean {
  const t = norm(term);
  if (t === "") return false;
  // Spaced scripts match on word boundaries; CJK, Arabic, Devanagari and Hangul contain.
  return SPACED.test(t) ? ` ${joined} `.includes(` ${t} `) : joined.includes(t);
}

const anyTerm = (joined: string, terms: readonly string[]): boolean =>
  terms.some((t) => termIn(joined, t));

const tokensOf = (joined: string): string[] => joined.split(" ").filter((w) => w !== "");

/** A password word inside any token or phrase (user_password, loginPassword, Passwort). */
const PASSWORD_WORDS = [
  "password",
  "passwd",
  "passwort",
  "kennwort",
  "passphrase",
  "passcode",
  "contrasena",
  "senha",
  "mot de passe",
  "motdepasse",
  "palavra passe",
  "wachtwoord",
  "losenord",
  "密码",
  "密碼",
  "パスワード",
  "비밀번호",
  "암호",
  "पासवर्ड",
  "كلمة المرور",
  "كلمة السر",
];
const PASSWORD_TOKENS = ["pwd", "pass phrase"];
/** A name that mentions a password without being one. */
const PASSWORD_EXCLUDE = [
  "hint",
  "hints",
  "forgot",
  "forgotten",
  "reset",
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
];

/** One-time, verification, security and recovery codes; CVC and friends. */
const CODE_PHRASES = [
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
  "authenticator code",
  "auth code",
  "authcode",
  "login code",
  "sms code",
  "security code",
  "securitycode",
  "approvals code",
  "two factor",
  "two step code",
  "two step verification",
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
];

/** Card number words in the shipped languages (the shared `isPaymentField` rule adds more). */
const CARD_NUMBER_PHRASES = [
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
];
/** A card word on something that is not the payment card. */
const CARD_EXCLUDE = [
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
  "statement",
  "title",
  "business",
  "sim",
  "id",
];

/** Bare "code" is an OTP only with context, and never beside these. */
const BARE_CODE = ["code", "codigo", "codice", "kode", "code"];
const BARE_CODE_CONTEXT = [
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
];
const BARE_CODE_EXCLUDE = [
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
];

const EXPIRY_NAMES = ["exp", "expiry", "expiration", "expdate", "exp date", "expiry date"];

const hasAny = (words: readonly string[], list: readonly string[]): boolean =>
  words.some((w) => list.includes(w));

function level(f: FieldFacts): SecureLevel | undefined {
  const tag = f.tag.toUpperCase();
  const type = (f.type ?? "").toLowerCase();
  const control =
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || f.contentEditable === true;
  if (!control) return undefined;
  if (tag === "INPUT" && type === "password") return "legacy";
  const ac = (f.autocomplete ?? "").toLowerCase().split(/\s+/);
  if (ac.some((t) => SECURE_AUTOCOMPLETE.test(t))) return "legacy";
  const textual =
    tag === "TEXTAREA" ||
    f.contentEditable === true ||
    (tag === "INPUT" && !NON_TEXT_TYPES.has(type));
  if (!textual) return undefined;
  // A search box asks about passwords and codes; it does not hold one.
  if (f.search === true || type === "search") return undefined;

  const texts = [f.name, f.id, f.ariaLabel, f.placeholder, f.label]
    .filter((t): t is string => typeof t === "string" && t !== "")
    .map(norm)
    .filter((t) => t !== "");
  if (texts.length === 0) return undefined;
  const all = texts.join(" ");
  const allWords = tokensOf(all);

  // Passwords, including one revealed by a toggle (`type=text`).
  for (const t of texts) {
    const words = tokensOf(t);
    const mentions =
      PASSWORD_WORDS.some((w) => t.includes(norm(w))) || hasAny(words, PASSWORD_TOKENS);
    if (mentions && !anyTerm(t, PASSWORD_EXCLUDE)) return "strong";
  }
  // One-time, verification, security and recovery codes; CVC.
  if (texts.some((t) => anyTerm(t, CODE_PHRASES))) return "strong";
  // CID is a card code only beside a card word (else it is a customer or campaign ID).
  if (allWords.includes("cid") && anyTerm(all, ["card", "credit", "amex", "payment", "security"])) {
    return "strong";
  }
  // Card numbers: the shared rule and the shipped-language lexicon, unless it is some other card.
  if (!anyTerm(all, CARD_EXCLUDE)) {
    if (texts.some((t) => anyTerm(t, CARD_NUMBER_PHRASES))) return "strong";
    if (
      isPaymentField({
        autocomplete: f.autocomplete,
        name: f.name,
        id: f.id,
        label: f.label ?? f.ariaLabel,
        placeholder: f.placeholder,
      })
    ) {
      return "strong";
    }
  }

  // Weaker signals: masked in snapshots and text, but they never refuse a screenshot.
  const idWords = tokensOf(
    [f.name, f.id]
      .filter(Boolean)
      .map((s) => norm(s as string))
      .join(" "),
  );
  if (hasAny(idWords, ["pan"])) return "weak";
  if (hasAny(idWords, EXPIRY_NAMES)) return "weak";
  if (/^\s*m{1,2}\s*[/-]\s*y{2,4}\s*$/i.test(f.placeholder ?? "")) return "weak";
  if (/\d{4}[ -]\d{4}[ -]\d{4}/.test(f.placeholder ?? "")) return "weak";
  if (
    [f.label, f.ariaLabel].some((t) =>
      /^(digit|character|char|dígito|chiffre|ziffer)\s*\d+(\s*(of|de|sur|von|\/)\s*\d+)?$/iu.test(
        (t ?? "").trim(),
      ),
    ) ||
    texts.some((t) => /^(otp|code|digit|pin|passcode) \d+$/.test(t))
  ) {
    return "weak";
  }
  // PIN is secret unless it reads as a postal code ("PIN code", `pincode`).
  if (hasAny(allWords, ["pin"]) || idWords.includes("idvpin")) {
    const postal =
      (hasAny(allWords, ["code"]) || allWords.includes("pincode")) &&
      !(f.maxLength !== undefined && f.maxLength <= 4);
    if (!postal) return "weak";
  }
  // Bare "code": an OTP beside "enter" / "sent" / "digit", or a field named just code.
  if (!anyTerm(all, BARE_CODE_EXCLUDE) && anyTerm(all, BARE_CODE)) {
    const named = texts.some(
      (t) => t === "code" || t === "codigo" || t === "codice" || t === "kode",
    );
    if (named || anyTerm(all, BARE_CODE_CONTEXT)) return "weak";
  }
  return undefined;
}

export const secureLevel = level;

/** `type=password` or a secure `autocomplete`: what typing is refused on. */
export function isLegacySecure(f: FieldFacts): boolean {
  return level(f) === "legacy";
}

/** The wide set: values are masked in snapshots, page text and `find`. */
export function isSecureField(f: FieldFacts): boolean {
  return level(f) !== undefined;
}

/** High confidence only: these refuse screenshots and drop recording frames. */
export function isStrongSecureField(f: FieldFacts): boolean {
  const l = level(f);
  return l === "legacy" || l === "strong";
}

// --- values ----------------------------------------------------------------------------------

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

/** The whole value is a payment card number (13-19 digits, Luhn-valid, spaces / dashes allowed). */
export function isCardNumberValue(v: string): boolean {
  if (!/^[\d -]{13,23}$/.test(v)) return false;
  const digits = v.replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhn(digits);
}

/** Replace every Luhn-valid 13-19 digit run in free text. */
export function maskCardNumbers(text: string, mask: string): string {
  return text.replace(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? mask : m;
  });
}

const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A scrubber for known secret values: each value (4+ characters) is replaced wherever it appears,
 * also when the page splits it over adjacent text runs ("4 8 2 9 1 3"). Card-number-shaped digit
 * runs are masked too.
 */
export function makeScrubber(values: Iterable<string>, mask: string): (s: string) => string {
  const res: RegExp[] = [];
  for (const raw of new Set(values)) {
    const v = raw.replace(/\s+/g, "");
    if (v.length < 4) continue;
    res.push(new RegExp([...v].map(escapeRe).join("\\s*"), "g"));
  }
  return (s: string) => {
    let out = s;
    for (const re of res) out = out.replace(re, mask);
    return maskCardNumbers(out, mask);
  };
}
