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
  /** The `title` attribute (a tooltip that is often the only label). */
  title?: string | undefined;
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
  /** Spaced phrases (`one time code`) as words, by their first word. */
  readonly #phrases = new Map<string, string[][]>();
  readonly #other: string[] = [];
  constructor(terms: readonly string[]) {
    for (const raw of terms) {
      const t = norm(raw);
      if (t === "") continue;
      if (!SPACED.test(t)) this.#other.push(t);
      else if (t.includes(" ")) {
        const words = t.split(" ");
        const first = words[0] as string;
        const list = this.#phrases.get(first) ?? [];
        list.push(words);
        this.#phrases.set(first, list);
      } else this.#words.add(t);
    }
  }
  /** One normalised word is a one-word term. */
  has(word: string): boolean {
    return this.#words.has(word);
  }
  in(x: Txt): boolean {
    const toks = x.toks;
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i] as string;
      if (this.#words.has(w)) return true;
      const ps = this.#phrases.get(w);
      if (ps === undefined) continue;
      // Compared in place: a long label costs its length, not length x occurrences.
      for (const p of ps) {
        let k = 1;
        while (k < p.length && toks[i + k] === p[k]) k++;
        if (k === p.length) return true;
      }
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
    `hint for ${w}`,
    `hint for your ${w}`,
    `${w} protected`,
    `${w} length`,
    `${w} recovery`,
    `${w} expires`,
    `${w} expiry`,
    `${w} expiration`,
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
  "reset code",
  "reset codes",
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
/**
 * Codes that are sent and still not secret: promo, gift, referral, invite, and the codes the
 * agent needs for a task (confirmation, booking, reservation, event, room, area, tracking).
 * They veto only where they modify the code word ("promo code", "código de descuento").
 */
const SENT_NOT_OTP = new Terms([
  "promo",
  "promotion",
  "promotional",
  "promocional",
  "coupon",
  "cupon",
  "discount",
  "descuento",
  "voucher",
  "gift",
  "referral",
  "invite",
  "invitation",
  "confirmation",
  "confirmacion",
  "booking",
  "reservation",
  "reserva",
  "event",
  "evento",
  "room",
  "area",
  "tracking",
  "postal",
  "zip",
]);
/**
 * Codes that are not an OTP when nothing says the code was sent: product and class codes, a
 * captcha, a code shown on a TV or in an image. Also only where they modify the code word.
 */
const SHOWN_NOT_OTP = new Terms([
  "product",
  "sku",
  "track",
  "shipment",
  "parcel",
  "captcha",
  "image",
  "picture",
  "shown",
  "displayed",
  "tv",
  "screen",
  "class",
  "game",
]);
/** Words a veto modifies (the code word itself). */
const VETOED_WORD = new Terms([
  "code",
  "codes",
  "codigo",
  "codice",
  "kode",
  "passcode",
  "pin",
  "key",
]);
/**
 * A veto word modifies a code word: up to two words before it ("promo code", "gift card code",
 * "TV code"), or after it ("código de descuento"; `after` words further for "code shown on your
 * TV"), or a word of the field's name or id. A veto anywhere else in the label ("the code we
 * sent to the number shown below") is not.
 */
function vetoed(
  texts: readonly Txt[],
  idWords: readonly string[],
  list: Terms,
  after: number,
): boolean {
  // The field's name or id says what it is (`name=referral`, `promoCode`).
  for (const w of idWords) if (list.has(w)) return true;
  for (const x of texts) {
    const toks = x.toks;
    for (let k = 0; k < toks.length; k++) {
      if (!VETOED_WORD.has(toks[k] as string)) continue;
      const from = Math.max(0, k - 2);
      const to = Math.min(toks.length - 1, k + after);
      for (let j = from; j <= to; j++) {
        if (j !== k && list.has(toks[j] as string)) return true;
      }
    }
  }
  return false;
}
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
  "room",
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
/** Characters of DOM text kept per label, labelled-by target or contenteditable, and per joined label. */
export const TEXT_CAP = 4096;
/**
 * Characters of any one text (name, id, title, placeholder, aria-label, label) the classifier
 * reads: a real label is far shorter, and a hostile 1 MB one costs no more than this.
 */
export const CLASSIFY_CAP = 1024;
const clip = (t: string): string => (t.length > CLASSIFY_CAP ? t.slice(0, CLASSIFY_CAP) : t);
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
  const id = f.id === undefined ? undefined : clip(f.id).replace(/^id[_-]/i, "");
  const name = f.name === undefined ? undefined : clip(f.name);
  const normed = new Map<string | undefined, string>();
  const n = (t: string | undefined): string => {
    let v = normed.get(t);
    if (v === undefined) {
      v = t === undefined ? "" : norm(t);
      normed.set(t, v);
    }
    return v;
  };
  const texts = [name, id, f.ariaLabel, f.placeholder, f.label, f.title]
    .filter((t): t is string => typeof t === "string" && t !== "")
    .map(clip)
    .map((t) => txt(n(t)))
    .filter((t) => t.t !== "");
  if (texts.length === 0) return undefined;
  const all = txt(texts.map((t) => t.t).join(" "));
  const allWords = all.toks;
  const idWords = [...tokensOf(n(name)), ...tokensOf(n(id))];

  // Passwords, including one revealed by a toggle (`type=text`).
  for (const t of texts) {
    if (mentionsPassword(t) && mentionsPassword(stripPasswordMentions(t))) return STRONG;
    if (t.toks.includes("clave") && !CLAVE_EXCLUDE.in(t)) return STRONG;
  }
  // One-time, verification, security and recovery codes; CVC.
  const sent = texts.some((t) => SENT.in(t));
  for (const t of texts) {
    const u = unCompound(t);
    if (CODE_PHRASES.in(u)) return STRONG;
    if (SECOND_FACTOR.in(t) && CODE_WORDS.in(t)) return STRONG;
    // "6-digit code", "the code we sent": an OTP, even beside "bank", "order" or "access".
    // Once a code was sent, only a sent non-secret code ("the promo code we emailed") vetoes;
    // "shown", "TV" or "product" elsewhere in the label do not.
    if (
      (N_DIGIT_CODE.test(t.t) || (CODE_WORD.in(t) && SENT.in(t))) &&
      !vetoed(texts, idWords, SENT_NOT_OTP, 2) &&
      (sent || !vetoed(texts, idWords, SHOWN_NOT_OTP, 4))
    ) {
      return STRONG;
    }
  }
  // CID is a card code only beside a card word (else it is a customer or campaign ID).
  if (allWords.includes("cid") && (CARD_CONTEXT.in(all) || allWords.includes("security"))) {
    return STRONG;
  }
  // Card numbers: the shared rule and the lexicon, unless that text names some other card.
  const raw = [name, id, f.label ?? f.ariaLabel, f.placeholder];
  for (const [i, r] of raw.entries()) {
    if (r === undefined || r === "") continue;
    const t = clip(r);
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
    const x = txt(n(clip(f.ariaLabel)));
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
    !BARE_CODE_EXCLUDE.in(all) &&
    (sent || !vetoed(texts, idWords, SHOWN_NOT_OTP, 4))
  ) {
    return STRONG;
  }

  // Weaker signals: masked in snapshots and text; screenshots only for a secret-shaped value.
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
  if (
    !BARE_CODE_EXCLUDE.in(all) &&
    BARE_CODE.in(all) &&
    (sent || !vetoed(texts, idWords, SHOWN_NOT_OTP, 4))
  ) {
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
  // A digit code or an expiry date is short; a long value is only `any` (and is not folded).
  if (value.length > 256) return shape === "any" && value.trim() !== "";
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
 * Text folded once into a canonical form for matching, the same for page text and values:
 * per code point NFKD with combining marks (`\p{M}`: accents, keycaps, variation selectors)
 * dropped, so NFC, NFD and decorated text agree; every decimal digit (`\p{Nd}`: fullwidth,
 * mathematical, Arabic-Indic, Bengali, Devanagari…) as ASCII; separators dropped. Separators are
 * whitespace, `.`, `-`, `/`, `|`, `_`, `,`, `:`, dashes, middle dots and bullets (and their
 * fullwidth forms). Invisible characters (`\p{Cf}` such as ZWSP, soft hyphen and word joiner, the
 * grapheme joiner, Hangul fillers, the braille blank) are dropped as soft separators: they split
 * digits for the glue check but not card groups. `at[i]`/`end[i]` map folded character `i` back
 * to the original text; `seps[i]` counts the separators just before it (`SOFT` set when an
 * invisible one was among them). No pattern is ever built from page values: matching is
 * Aho-Corasick over this string.
 */
interface Folded {
  s: string;
  at: Int32Array;
  end: Int32Array;
  seps: Uint16Array;
}

const SEP_ASCII = new Uint8Array(128);
for (const c of "\t\n\v\f\r .-/|_,:") SEP_ASCII[c.charCodeAt(0)] = 1;
const SEP_OTHER = /^[\s‐-―−·・，－．／＿｜•‧∙⋅：]$/u;
/** Invisible characters: format (`Cf`), grapheme joiner, Hangul fillers, braille blank. */
const IGNORABLE = /^[\p{Cf}\u034f\u115f\u1160\u3164\uffa0\u2800\u180b-\u180f\ufe00-\ufe0f]$/u;
const MARK = /^\p{M}$/u;
const ND = /^\p{Nd}$/u;
/** `seps` flag: an invisible character sat among the separators. */
const SOFT = 0x8000;
/** Separators before a folded character, invisible ones not counted. */
const hard = (n: number | undefined): number => (n ?? 0) & 0x7fff;

/**
 * Folded form of one non-ASCII code point: "" dropped, "\u0000" a separator, "\u0001" an
 * invisible (soft) separator, else the text.
 */
const FOLD_CACHE = new Map<number, string>();
function foldCodePoint(cp: number): string {
  const hit = FOLD_CACHE.get(cp);
  if (hit !== undefined) return hit;
  const ch = String.fromCodePoint(cp);
  let out: string;
  if (IGNORABLE.test(ch)) out = "\u0001";
  else if (MARK.test(ch)) out = "";
  else if (SEP_OTHER.test(ch)) out = "\u0000";
  else if (ND.test(ch)) out = String(digitValue(cp));
  else {
    out = "";
    for (const f of ch.normalize("NFKD")) {
      const c = f.charCodeAt(0);
      if (MARK.test(f)) continue;
      if (c < 128 ? SEP_ASCII[c] === 1 : SEP_OTHER.test(f)) out += "\u0000";
      else if (ND.test(f)) out += String(digitValue(f.codePointAt(0) ?? c));
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

interface FoldBuf {
  cap: number;
  codes: Uint16Array;
  at: Int32Array;
  end: Int32Array;
  seps: Uint16Array;
}
const allocBuf = (cap: number): FoldBuf => ({
  cap,
  codes: new Uint16Array(cap),
  at: new Int32Array(cap),
  end: new Int32Array(cap),
  seps: new Uint16Array(cap),
});
/** Folds up to this many characters reuse one shared buffer; larger ones get their own. */
const SHARED_FOLD_CAP = 1 << 20;
/**
 * Scratch buffers shared by `fold` calls (synchronous, so never in use twice at once). They never
 * grow past `SHARED_FOLD_CAP`, so one huge page does not pin hundreds of MB for the process life.
 */
let BUF = allocBuf(0);
function grow(b: FoldBuf, need: number): FoldBuf {
  let c = Math.max(need, b.cap * 2, 1024);
  if (need <= SHARED_FOLD_CAP) c = Math.min(c, SHARED_FOLD_CAP);
  const next = allocBuf(c);
  next.codes.set(b.codes);
  next.at.set(b.at);
  next.end.set(b.end);
  next.seps.set(b.seps);
  return next;
}

/** Capacity of the shared fold buffers (tests). */
export const foldBufferCapacity = (): number => BUF.cap;

/** The fold of `text`; its arrays are views of scratch buffers, valid until the next call. */
function fold(text: string): Folded {
  const n = text.length;
  let b = n + 8 > SHARED_FOLD_CAP ? allocBuf(n + 8) : BUF.cap >= n + 8 ? BUF : grow(BUF, n + 8);
  let len = 0;
  let sep = 0;
  let soft = false;
  const push = (code: number, from: number, to: number) => {
    if (len >= b.cap) b = grow(b, len + 1);
    b.codes[len] = code;
    b.at[len] = from;
    b.end[len] = to;
    b.seps[len] = (sep > 0x7fff ? 0x7fff : sep) | (soft ? SOFT : 0);
    sep = 0;
    soft = false;
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
      else if (fc === 1) soft = true;
      else push(fc, i, i + w);
    }
    i += w;
  }
  if (b.cap <= SHARED_FOLD_CAP) BUF = b;
  let s = "";
  for (let i = 0; i < len; i += 8192) {
    s += String.fromCharCode(...b.codes.subarray(i, Math.min(len, i + 8192)));
  }
  return {
    s,
    at: b.at.subarray(0, len),
    end: b.end.subarray(0, len),
    seps: b.seps.subarray(0, len),
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

/** A value up to this many folded characters is tracked whole, in `MAX_SECRET_CHARS` pieces. */
export const MAX_WHOLE_SECRET = 8192;
/** Of a longer value, its first and last this many folded characters are tracked. */
const SECRET_EDGE = 4096;

/**
 * `s` in pieces of at most `MAX_SECRET_CHARS`, each starting `PREFIX_KEY + 1` characters before
 * the previous one ends. A truncated echo that runs past a piece's end so holds the next piece's
 * prefix, ending where no earlier piece ends (the matcher reports only the longest key ending at
 * a position), and the scrubber extends it (`makeScrubber`). The last piece is the rest (longer
 * than `PREFIX_KEY`).
 */
function pieces(s: string, out: string[]): void {
  const stride = MAX_SECRET_CHARS - PREFIX_KEY - 1;
  for (let i = 0; ; i += stride) {
    if (i + MAX_SECRET_CHARS >= s.length) {
      out.push(s.slice(i));
      return;
    }
    out.push(s.slice(i, i + MAX_SECRET_CHARS));
  }
}

/**
 * The scrubber's keys for one value: its fold, or for a value over `MAX_SECRET_CHARS` folded,
 * overlapping pieces of that size (an echo of the value is masked piece by piece). A value over
 * `MAX_WHOLE_SECRET` folded is tracked by its first and last `SECRET_EDGE` characters only.
 * Never more than 2 * (SECRET_EDGE / (MAX_SECRET_CHARS - PREFIX_KEY - 1) + 1) keys.
 */
export function secretKeys(value: string): string[] {
  const out: string[] = [];
  // Fold only what can hold the tracked keys (separators make the original longer).
  const reach = MAX_WHOLE_SECRET * 4;
  if (value.length > reach) {
    const head = foldedSecret(value.slice(0, reach / 2));
    const tail = foldedSecret(value.slice(-reach / 2));
    pieces(head.slice(0, SECRET_EDGE), out);
    pieces(tail.slice(-SECRET_EDGE), out);
    return out;
  }
  const v = foldedSecret(value);
  if (v.length <= MAX_WHOLE_SECRET) pieces(v, out);
  else {
    pieces(v.slice(0, SECRET_EDGE), out);
    pieces(v.slice(-SECRET_EDGE), out);
  }
  return out;
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
    for (; j < s.length && isDigitCode(s.charCodeAt(j)) && hard(f.seps[j]) <= 6; j++) {
      if (hard(f.seps[j]) > 0) {
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
    while (j < s.length && isDigitCode(s.charCodeAt(j)) && hard(f.seps[j]) <= 6) j++;
    if (j - i >= 4) out.push([i, j - 1]);
    i = j;
  }
}

/** Tracked secret keys: at most this many, each at most `MAX_SECRET_CHARS` folded. */
export const MAX_SECRETS = 256;
export const MAX_SECRET_CHARS = 256;
/** A match this long is masked even inside a longer number (the glue check is for short PINs). */
const GLUE_MAX = 32;
/**
 * A key longer than `PREFIX_KEY` folded characters is also found by its first `PREFIX_KEY`, and
 * that match is extended along the key as far as the text agrees: a truncated echo of a token
 * (`eyJhbGciOi…`) is masked too. At most `PREFIX_FANOUT` keys per prefix are tried, and one
 * extension per masked region (plus the one chained from its last `PREFIX_KEY` characters), so
 * the cost stays linear in the text.
 */
const PREFIX_KEY = 16;
const PREFIX_FANOUT = 8;

export interface Scrubber {
  /** Mask secret values (separators, zero-width and other digit forms ignored) and card numbers. */
  scrub(text: string): string;
  /** Text spans `[start, end)` that `scrub` masks, sorted and merged. */
  spans(text: string): [number, number][];
}

const MAY_HOLD_DIGITS = /\p{Nd}/u;

/**
 * Masks known secret values and card numbers in one pass over the folded text. `failClosed`
 * (more secrets than are tracked) also masks every run of four or more digits.
 */
export function makeScrubber(
  values: Iterable<string>,
  mask: string,
  options: { failClosed?: boolean } = {},
): Scrubber {
  const keys = [...new Set([...values].flatMap(secretKeys))].filter((k) => k.length >= 4);
  const byPrefix = new Map<string, string[]>();
  for (const k of keys) {
    if (k.length <= PREFIX_KEY) continue;
    const pre = k.slice(0, PREFIX_KEY);
    const list = byPrefix.get(pre) ?? [];
    if (list.length < PREFIX_FANOUT) list.push(k);
    byPrefix.set(pre, list);
  }
  const patterns = [...new Set([...keys, ...byPrefix.keys()])];
  const matcher = patterns.length === 0 ? undefined : new Matcher(patterns);
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
    // End of the last prefix extension. A match starting inside it is masked already; only one
    // starting in its last PREFIX_KEY characters (the next piece of a long value) extends it.
    let extended = -1 - PREFIX_KEY;
    matcher?.search(f.s, (end, len) => {
      const a = end - len + 1;
      let b = end;
      if (len === PREFIX_KEY && a >= extended - PREFIX_KEY) {
        const cands = byPrefix.get(f.s.slice(a, end + 1));
        if (cands !== undefined) {
          for (const k of cands) {
            let j = PREFIX_KEY;
            while (
              j < k.length &&
              a + j < f.s.length &&
              f.s.charCodeAt(a + j) === k.charCodeAt(j)
            ) {
              j++;
            }
            b = Math.max(b, a + j - 1);
          }
          // The next extension must start in this one's tail, so each costs new text.
          extended = Math.max(b, extended + PREFIX_KEY + 1);
        }
      }
      const n = b - a + 1;
      // Not inside a longer number: "1234" is not masked in "12345" (an invisible character
      // between the digits separates them).
      const glued =
        n < GLUE_MAX &&
        ((a > 0 &&
          f.seps[a] === 0 &&
          isDigitCode(f.s.charCodeAt(a)) &&
          isDigitCode(f.s.charCodeAt(a - 1))) ||
          (b + 1 < f.s.length &&
            f.seps[b + 1] === 0 &&
            isDigitCode(f.s.charCodeAt(b)) &&
            isDigitCode(f.s.charCodeAt(b + 1))));
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
