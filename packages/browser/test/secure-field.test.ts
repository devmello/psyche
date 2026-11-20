import { describe, expect, it } from "vitest";
import type { AXNode, CaptureSnapshotResult } from "../src/cdp/types.ts";
import { redactUrl } from "../src/origin/redact-url.ts";
import {
  buildSnapshot,
  extractText,
  hasFieldCandidates,
  SECURE_MASK,
} from "../src/snapshot/builder.ts";
import { DomIndex } from "../src/snapshot/dom.ts";
import { RefRegistry } from "../src/snapshot/refs.ts";
import {
  blocksScreenshot,
  classifyField,
  type FieldFacts,
  isLegacySecure,
  isSecureField,
  isStrongSecureField,
  MAX_SECRET_CHARS,
  MAX_SECRETS,
  makeScrubber,
  maskCardNumbers,
  secureLevel,
} from "../src/snapshot/secure-field.ts";

const input = (f: Omit<FieldFacts, "tag">): FieldFacts => ({ tag: "INPUT", ...f });

const MUST_HIDE: [string, FieldFacts][] = [
  ["type=password", input({ type: "password" })],
  ["type=PASSWORD (case)", input({ type: "PASSWORD" })],
  ["current-password", input({ type: "text", autocomplete: "current-password" })],
  ["new-password", input({ type: "text", autocomplete: "new-password" })],
  ["one-time-code on type=text", input({ type: "text", autocomplete: "one-time-code" })],
  ["cc-number", input({ autocomplete: "cc-number" })],
  ["cc-csc with a section token", input({ autocomplete: "section-pay cc-csc" })],
  ["cc-exp", input({ autocomplete: "cc-exp" })],
  ["cc-exp-month", input({ autocomplete: "cc-exp-month" })],
  ["cc-exp-year", input({ autocomplete: "cc-exp-year" })],
  ["name otp", input({ name: "otp" })],
  ["name totp_code", input({ name: "totp_code" })],
  ["id mfaCode camelCase", input({ id: "mfaCode" })],
  ["label Verification code", input({ label: "Verification code" })],
  ["placeholder One-time code", input({ placeholder: "One-time code" })],
  ["aria-label Two-factor code", input({ ariaLabel: "Two-factor code" })],
  ["name cvv", input({ name: "cvv" })],
  ["name card-cvc", input({ name: "card-cvc" })],
  ["label Card security code", input({ label: "Card security code" })],
  ["label Card number", input({ label: "Card number" })],
  ["name cardnumber", input({ name: "cardnumber" })],
  ["revealed password: name password", input({ type: "text", name: "password" })],
  ["revealed password: Confirm password", input({ type: "text", label: "Confirm password" })],
  ["textarea named otp", { tag: "TEXTAREA", name: "otp" }],
  [
    "contenteditable Verification code",
    { tag: "DIV", contentEditable: true, label: "Verification code" },
  ],
  [
    "contenteditable one-time-code",
    { tag: "DIV", contentEditable: true, autocomplete: "one-time-code" },
  ],
  // Review round 1: other languages
  ["es Código de verificación", input({ label: "Código de verificación" })],
  ["es Código + name codigo", input({ label: "Código", name: "codigo" })],
  ["de Passwort (revealed)", input({ type: "text", label: "Passwort" })],
  ["fr Mot de passe (revealed)", input({ type: "text", label: "Mot de passe" })],
  ["es Contraseña (revealed)", input({ type: "text", label: "Contraseña" })],
  ["zh 密码 (revealed)", input({ type: "text", label: "密码" })],
  ["ja パスワード (revealed)", input({ type: "text", label: "パスワード" })],
  ["ko 비밀번호 (revealed)", input({ type: "text", label: "비밀번호" })],
  ["pt Senha (revealed)", input({ type: "text", label: "Senha" })],
  ["hi पासवर्ड (revealed)", input({ type: "text", label: "पासवर्ड" })],
  ["ar كلمة المرور (revealed)", input({ type: "text", label: "كلمة المرور" })],
  ["zh 验证码", input({ label: "验证码" })],
  ["ja 認証コード", input({ label: "認証コード" })],
  ["ko 인증번호", input({ label: "인증번호" })],
  ["hi सत्यापन कोड", input({ label: "सत्यापन कोड" })],
  ["ar رمز التحقق", input({ label: "رمز التحقق" })],
  ["de Bestätigungscode", input({ label: "Bestätigungscode" })],
  ["de Sicherheitscode", input({ label: "Sicherheitscode" })],
  ["it Codice di verifica", input({ label: "Codice di verifica" })],
  ["pt Código de verificação", input({ label: "Código de verificação" })],
  ["de Kartennummer", input({ label: "Kartennummer" })],
  ["fr Numéro de carte", input({ label: "Numéro de carte" })],
  ["es Número de tarjeta", input({ label: "Número de tarjeta" })],
  ["it Numero della carta", input({ label: "Numero della carta" })],
  ["pt Número do cartão", input({ label: "Número do cartão" })],
  ["zh 卡号", input({ label: "卡号" })],
  ["ja カード番号", input({ label: "カード番号" })],
  ["ko 카드번호", input({ label: "카드번호" })],
  ["fr Cryptogramme visuel", input({ label: "Cryptogramme visuel" })],
  // PIN
  ["PIN", input({ label: "PIN", name: "pin" })],
  ["card_pin", input({ name: "card_pin", label: "Card PIN" })],
  ["Gift card PIN", input({ label: "Gift card PIN" })],
  ["PIN code, 4 digits", input({ label: "Your PIN code", type: "tel", maxLength: 4 })],
  ["idvPin", input({ name: "idvPin" })],
  // OTP by name or label
  [
    "Enter the 6-digit code we sent",
    input({ name: "code", label: "Enter the 6-digit code we sent" }),
  ],
  ["Enter code", input({ name: "code", label: "Enter code" })],
  ["name otc", input({ name: "otc" })],
  ["name auth_code", input({ name: "auth_code" })],
  ["name mfa", input({ name: "mfa" })],
  ["name 2fa", input({ name: "2fa" })],
  ["name tfa_code", input({ name: "tfa_code" })],
  ["name approvals_code", input({ name: "approvals_code" })],
  ["Recovery code", input({ label: "Recovery code" })],
  ["Backup code", input({ label: "Backup code" })],
  // split OTP boxes
  ["code-0 + Digit 1", input({ name: "code-0", ariaLabel: "Digit 1" })],
  ["Character 1 of 6", input({ ariaLabel: "Character 1 of 6" })],
  // cards
  ["tel named pan", input({ type: "tel", name: "pan" })],
  ["number + 1234 1234 1234 1234", input({ name: "number", placeholder: "1234 1234 1234 1234" })],
  ["name cv2", input({ name: "cv2" })],
  ["name cvn", input({ name: "cvn" })],
  ["name cvc2", input({ name: "cvc2" })],
  ["cid beside card", input({ name: "cid", label: "Card ID code" })],
  ["exp + Expiration date", input({ name: "exp", label: "Expiration date" })],
  ["expiry + MM / YY", input({ name: "expiry", placeholder: "MM / YY" })],
  // revealed passwords
  ["user_password", input({ type: "text", name: "user_password" })],
  ["user[password]", input({ type: "text", name: "user[password]" })],
  ["loginPassword", input({ type: "text", name: "loginPassword" })],
  ["session[password]", input({ type: "text", name: "session[password]" })],
  ["Enter password", input({ type: "text", label: "Enter password" })],
  ["Enter your password", input({ type: "text", label: "Enter your password" })],
  ["Your password", input({ type: "text", label: "Your password" })],
  ["Password (required)", input({ type: "text", label: "Password (required)" })],
  ["Wi-Fi password (revealed)", input({ type: "text", label: "Wi-Fi password" })],
  // Review round 2: split boxes named with a digit, no aria-label
  ["otp1 maxlength 1", input({ name: "otp1", maxLength: 1 })],
  ["code1 maxlength 1", input({ name: "code1", maxLength: 1 })],
  ["digit1 maxlength 1", input({ name: "digit1", maxLength: 1 })],
  ["pin1 maxlength 1", input({ name: "pin1", maxLength: 1 })],
  ["OTPCode (acronym camelCase)", input({ name: "OTPCode" })],
  ["2FA in capitals", input({ label: "2FA" })],
  ["zero-width inside the name", input({ name: "o​tp" })],
  // Review round 2: card exclusion per text
  ["Django id_card_number", input({ name: "card_number", id: "id_card_number" })],
  ["Business card number", input({ label: "Business card number" })],
  ["Card number as on the statement", input({ label: "Card number as shown on your statement" })],
  ["cardNumber beside a title-ish id", input({ name: "cardNumber", id: "card-title-number" })],
  // Review round 2: lexicon gaps
  ["emailCode", input({ name: "emailCode", label: "Email code" })],
  ["de Prüfnummer", input({ label: "Prüfnummer" })],
  ["de Kartenprüfnummer", input({ label: "Kartenprüfnummer" })],
  ["de Gültig bis", input({ label: "Gültig bis", name: "gueltig_bis" })],
  ["es Fecha de vencimiento", input({ label: "Fecha de vencimiento", name: "vencimiento" })],
  ["fr Date d'expiration", input({ label: "Date d'expiration", name: "date_exp" })],
  ["de Geheimzahl", input({ label: "Geheimzahl" })],
  ["es Clave (type=text)", input({ type: "text", label: "Clave", name: "clave" })],
  ["es Clave de acceso", input({ type: "text", label: "Clave de acceso" })],
  ["ja ワンタイムパスワード", input({ label: "ワンタイムパスワード" })],
  ["hi ओटीपी", input({ label: "ओटीपी दर्ज करें" })],
  ["es CVV in brackets", input({ label: "Código de seguridad (CVV)" })],
  ["fr Code de sécurité", input({ label: "Code de sécurité" })],
  ["zh 支付密码", input({ type: "text", label: "支付密码" })],
  ["ko 비밀번호를 입력하세요 (particle)", input({ type: "text", label: "비밀번호를 입력하세요" })],
  // Promoted to strong (owner decision)
  ["authenticator app", input({ label: "Enter the code from your authenticator app" })],
  ["6-digit code", input({ label: "6-digit code" })],
  ["es código de 6 dígitos", input({ label: "Introduce el código de 6 dígitos" })],
  ["Code + placeholder 123456", input({ label: "Code", placeholder: "123456" })],
  // PAN: also an Indian tax id, which is sensitive too (owner decision: any value)
  ["PAN number (Indian tax id)", input({ name: "pan", label: "PAN number" })],
  // Review round 3: real OTPs the bank / order / access exclusions unmasked
  [
    "3-D Secure: the code your bank sent",
    input({ label: "Enter the code your bank sent to your phone", name: "challengeDataEntry" }),
  ],
  [
    "6-digit code to confirm your order",
    input({ label: "Enter the 6-digit code to confirm your order" }),
  ],
  [
    "access code we sent to your phone",
    input({ label: "Enter the access code we sent to your phone" }),
  ],
  ["6-digit access code", input({ label: "6-digit access code" })],
  [
    "the code we sent to confirm this payment",
    input({ label: "Enter the code we sent to confirm this payment" }),
  ],
  // Review round 3: revealed passwords whose label also holds help text
  [
    "Drupal: label wraps its Forgot link",
    input({ type: "text", name: "pass", id: "edit-pass", label: "Password Forgot your password?" }),
  ],
  [
    "Password (see requirements)",
    input({ type: "text", name: "pw", label: "Password (see requirements)" }),
  ],
  ["Password Need help?", input({ type: "text", name: "pw", label: "Password Need help?" })],
  ["Password for this link", input({ type: "text", name: "lp", label: "Password for this link" })],
  [
    "Password manager master password",
    input({ type: "text", label: "Password manager master password" }),
  ],
  [
    "was type=password before a reveal",
    input({ type: "text", name: "f1", label: "Notes", wasPassword: true }),
  ],
  ["zero-width in the label", input({ type: "text", label: "Pass\u200bword" })],
  ["fullwidth label", input({ type: "text", label: "Ｐａｓｓｗｏｒｄ" })],
  ["soft hyphen in the label", input({ type: "text", label: "Pass\u00adword" })],
  ["Wallet passphrase", input({ type: "text", label: "Wallet passphrase" })],
  ["Online-Banking PIN", input({ label: "Online-Banking PIN" })],
  ["id card_id_3, label Card number", input({ label: "Card number", id: "card_id_3" })],
];

const MUST_NOT_HIDE: [string, FieldFacts][] = [
  ["plain text field", input({ type: "text", name: "username", label: "Username" })],
  ["Password hint text field", input({ type: "text", name: "hint", label: "Password hint" })],
  ["name password_hint", input({ type: "text", name: "password_hint" })],
  ["Forgot your password", input({ type: "text", label: "Forgot your password email" })],
  [
    "Search passwords (type=search, name q)",
    input({ type: "search", name: "q", label: "Search passwords" }),
  ],
  [
    "search: forgot password",
    input({ type: "search", label: "Search help articles: forgot password" }),
  ],
  ["search box named pass", input({ type: "search", name: "pass", label: "Find a flight" })],
  [
    "search: what is a security code",
    input({ type: "search", label: "Search: what is a security code" }),
  ],
  ["search: where is my CVV", input({ type: "search", label: "Search: where is my CVV" })],
  [
    "search placeholder card number help",
    input({ type: "search", placeholder: "Search card number help" }),
  ],
  ["role=searchbox security code", input({ search: true, label: "Find a security code" })],
  ["boarding pass", input({ type: "text", name: "boarding_pass", label: "Boarding pass" })],
  ["autocomplete username", input({ autocomplete: "username" })],
  ["autocomplete email", input({ autocomplete: "email" })],
  ["email Cc", input({ name: "cc", label: "Cc" })],
  ["library card number", input({ name: "library-card", label: "Library card number" })],
  ["gift card message", input({ label: "Message on the card" })],
  ["otp-like word inside another", input({ name: "hotpot" })],
  ["checkbox named otp", input({ type: "checkbox", name: "otp" })],
  ["submit button named cvv", input({ type: "submit", name: "cvv" })],
  ["a paragraph", { tag: "P", label: "Verification code" }],
  ["a div that is not editable", { tag: "DIV", label: "Verification code" }],
  ["contenteditable body", { tag: "DIV", contentEditable: true, label: "Message body" }],
  // Review round 1: false positives
  [
    "Confirmation code (airline PNR)",
    input({ label: "Confirmation code", name: "confirmationCode" }),
  ],
  ["Order confirmation code", input({ label: "Order confirmation code" })],
  ["cid = Customer ID", input({ name: "cid", label: "Customer ID" })],
  ["Credit card nickname", input({ label: "Credit card nickname" })],
  ["Credit card statement descriptor", input({ label: "Credit card statement descriptor" })],
  ["Gift card number", input({ label: "Gift card number" })],
  ["PIN code (postal) + pincode", input({ label: "PIN code", name: "pincode" })],
  ["Promo code", input({ label: "Promo code", name: "promo" })],
  ["Coupon code", input({ label: "Coupon code" })],
  ["Postal code", input({ label: "Postal code", name: "postal_code" })],
  ["Booking code", input({ label: "Booking code" })],
  ["Business card title", input({ label: "Business card title" })],
  ["Card title textarea", { tag: "TEXTAREA", label: "Card title" }],
  // The autocomplete rule is for fields, not for a <form> or a <div>
  ["form autocomplete=new-password", { tag: "FORM", autocomplete: "new-password" }],
  ["div autocomplete=one-time-code", { tag: "DIV", autocomplete: "one-time-code" }],
  // Review round 2: were strong
  ["pt resenha (a review)", { tag: "TEXTAREA", label: "Escreva sua resenha" }],
  ["ko 암호화폐 지갑 주소 (crypto address)", input({ label: "암호화폐 지갑 주소" })],
  ["ko 일회용품 이름 (disposable goods)", input({ label: "일회용품 이름" })],
  ["zh 密码学 (cryptography)", input({ label: "密码学课程" })],
  ["Two-factor phone number", input({ label: "Two-factor phone number" })],
  [
    "Why are you changing your password?",
    { tag: "TEXTAREA", label: "Why are you changing your password?" },
  ],
  ["Email for password resets", input({ label: "Email for password resets" })],
  ["passport number (pass prefix)", input({ label: "Passport number", name: "passport" })],
  // Review round 2: were weak
  ["code editor textarea name=code", { tag: "TEXTAREA", name: "code" }],
  ["paste site: Enter your code here", { tag: "TEXTAREA", placeholder: "Enter your code here" }],
  ["Enter access code", input({ label: "Enter access code" })],
  ["Enter tracking code", input({ label: "Enter tracking code" })],
  ["Enter gift card code", input({ label: "Enter gift card code" })],
  ["Enter ZIP code", input({ label: "Enter ZIP code" })],
  ["exp: Years of experience", input({ name: "exp", label: "Years of experience" })],
  ["exp_points", input({ name: "exp_points" })],
  ["Pin title", input({ label: "Pin title" })],
  ["Drop a pin: address", input({ label: "Drop a pin: address" })],
  ["pin_board", input({ name: "pin_board" })],
  ["Security question", input({ label: "Security question" })],
  ["Employee number", input({ label: "Employee number" })],
  ["Discount: Enter code", input({ label: "Enter code", name: "discount" })],
  [
    "Referral code we sent",
    input({ label: "Enter the code your friend sent you", name: "referral" }),
  ],
  ["Invite code we sent", input({ label: "Enter the invite code we sent" })],
  ["Area code", input({ label: "Area code" })],
  ["Country code", input({ label: "Country code" })],
  ["8-digit product code", input({ label: "Enter the 8-digit product code" })],
  ["Class code", input({ label: "Class code" })],
  ["ZIP code with a sample placeholder", input({ label: "ZIP code", placeholder: "94105" })],
  [
    "postal PIN code with a sample placeholder",
    input({ label: "PIN code", name: "pincode", placeholder: "560001" }),
  ],
  ["es Palabra clave (keyword)", input({ label: "Palabra clave" })],
  ["three one-character inputs are not a split OTP", input({ name: "initial", maxLength: 1 })],
  // Review round 3
  ["Zoom Meeting ID", input({ label: "Meeting ID or Personal Link Name" })],
  ["Sort code", input({ label: "Sort code" })],
  ["Bankleitzahl", input({ label: "Bankleitzahl" })],
  ["Pin a comment", input({ label: "Pin a comment" })],
  ["SKU", input({ label: "SKU" })],
  ["Pincode", input({ label: "Pincode" })],
  ["Name on card", input({ label: "Name on card" })],
  ["Last 4 digits of your card", input({ label: "Last 4 digits of your card" })],
  ["Password strength", input({ label: "Password strength" })],
  [
    "Reason for changing your password",
    { tag: "TEXTAREA", label: "Reason for changing your password" },
  ],
  ["Invite code", input({ label: "Invite code" })],
  ["Clave del producto", input({ label: "Clave del producto" })],
  ["Wi-Fi network name", input({ label: "Wi-Fi network name" })],
  ["Commit message", { tag: "TEXTAREA", label: "Commit message", name: "message" }],
  ["Game PIN (Kahoot)", input({ label: "Game PIN", name: "gameId" })],
  ["Pin repository", input({ label: "Pin repository" })],
  ["pan_size", input({ name: "pan_size", label: "Pan size" })],
  ["pan_x (map)", input({ name: "pan_x" })],
  ["Clave (instrument)", input({ label: "Clave (instrument)" })],
  [
    "captcha: the code shown in the image",
    input({ label: "Enter the code shown in the image", name: "captcha" }),
  ],
  ["TV pairing code", input({ label: "Enter the code shown on your TV" })],
  [
    "Referral code your friend sent",
    input({ label: "Enter the code your friend sent you", name: "referral" }),
  ],
];

describe("secret field classifier (masking)", () => {
  it.each(MUST_HIDE)("hides: %s", (_n, f) => {
    expect(isSecureField(f)).toBe(true);
  });
  it.each(MUST_NOT_HIDE)("keeps visible: %s", (_n, f) => {
    expect(isSecureField(f)).toBe(false);
  });
});

describe("secret field levels", () => {
  const LEVELS: [string, FieldFacts, ReturnType<typeof secureLevel>][] = [
    ["type=password", input({ type: "password" }), "legacy"],
    ["one-time-code on text", input({ autocomplete: "one-time-code" }), "legacy"],
    ["name otp", input({ name: "otp" }), "strong"],
    ["card security code", input({ label: "Card security code" }), "strong"],
    ["revealed password", input({ type: "text", name: "password" }), "strong"],
    ["bare code with context", input({ name: "code", label: "Enter code" }), "weak"],
    ["PIN", input({ name: "pin" }), "weak"],
    ["pan", input({ name: "pan" }), "weak"],
    ["split digit", input({ ariaLabel: "Digit 1" }), "weak"],
    ["code1 box", input({ name: "code1", maxLength: 1 }), "weak"],
    ["Confirmation code", input({ label: "Confirmation code" }), undefined],
    // Promoted to strong (owner decision)
    ["authenticator", input({ label: "Enter the code from your authenticator app" }), "strong"],
    ["6-digit code", input({ label: "6-digit code" }), "strong"],
    [
      "Enter the 6-digit code we sent",
      input({ name: "code", label: "Enter the 6-digit code we sent" }),
      "strong",
    ],
    ["placeholder 123456", input({ label: "Code", placeholder: "123456" }), "strong"],
    ["split box (DOM group)", input({ name: "x1", maxLength: 1, splitBox: true }), "strong"],
    ["otp1", input({ name: "otp1", maxLength: 1 }), "strong"],
  ];
  it.each(LEVELS)("%s", (_n, f, level) => {
    expect(secureLevel(f)).toBe(level);
  });
  it("weak fields carry the shape their value must have to refuse screenshots", () => {
    expect(classifyField(input({ name: "pin" }))?.shape).toBe("digits");
    expect(classifyField(input({ ariaLabel: "Digit 1" }))?.shape).toBe("digits");
    expect(classifyField(input({ label: "Expiration date", name: "exp" }))?.shape).toBe("expiry");
    expect(classifyField(input({ name: "pan" }))?.shape).toBe("any");
  });
  it("typing is refused only on the old criteria", () => {
    expect(isLegacySecure(input({ type: "password" }))).toBe(true);
    expect(isLegacySecure(input({ type: "text", autocomplete: "one-time-code" }))).toBe(true);
    expect(isLegacySecure(input({ name: "otp" }))).toBe(false);
    expect(isLegacySecure(input({ label: "Card security code" }))).toBe(false);
  });
  it("legacy and strong refuse screenshots whatever the value", () => {
    expect(isStrongSecureField(input({ name: "otp" }))).toBe(true);
    expect(isStrongSecureField(input({ name: "code", label: "Enter code" }))).toBe(false);
    expect(isStrongSecureField(input({ name: "pin" }))).toBe(false);
    expect(blocksScreenshot(classifyField(input({ name: "otp" })), "anything")).toBe(true);
    expect(blocksScreenshot(classifyField(input({ type: "password" })), "x")).toBe(true);
  });
  const SHAPES: [string, FieldFacts, string, boolean][] = [
    ["code: 6 digits", input({ name: "code", label: "Enter code" }), "482913", true],
    ["code: spaced digits", input({ name: "code", label: "Enter code" }), "482 913", true],
    ["code: fullwidth digits", input({ name: "code", label: "Enter code" }), "４８２９１３", true],
    ["code: a word", input({ name: "code", label: "Enter code" }), "SUMMER-SALE", false],
    ["code: 9 digits", input({ name: "code", label: "Enter code" }), "123456789", false],
    ["digit box: one digit", input({ ariaLabel: "Digit 1" }), "4", true],
    ["digit box: a letter", input({ ariaLabel: "Digit 1" }), "x", false],
    ["PIN: 4 digits", input({ name: "pin" }), "1234", true],
    ["expiry: 12/29", input({ label: "Expiration date", name: "exp" }), "12/29", true],
    ["expiry: 12 / 2029", input({ label: "Expiration date", name: "exp" }), "12 / 2029", true],
    ["expiry: 1229", input({ label: "Expiration date", name: "exp" }), "1229", true],
    ["expiry: a full date", input({ label: "Expiration date", name: "exp" }), "2029-12-01", false],
    ["expiry: 13/29", input({ label: "Expiration date", name: "exp" }), "13/29", false],
    ["pan: anything", input({ name: "pan" }), "ABCDE1234F", true],
    ["no value", input({ name: "pin" }), "", false],
  ];
  it.each(SHAPES)("weak screenshot gate: %s", (_n, f, value, blocks) => {
    expect(blocksScreenshot(classifyField(f), value)).toBe(blocks);
  });
});

describe("value backstop: disguised secrets and card numbers", () => {
  const s = makeScrubber(["482913", "hunter2-secret"], SECURE_MASK);
  const HIDDEN: [string, string][] = [
    ["plain", "code 482913"],
    ["spaced", "code 4 8 2 9 1 3"],
    ["zero-width joined", "code 4​8​2​9​1​3"],
    ["dashes", "code 48-29-13"],
    ["dots", "code 4.8.2.9.1.3"],
    ["newlines (slots in read_text)", "4\n8\n2\n9\n1\n3"],
    ["fullwidth", "code ４８２９１３"],
    ["Arabic-Indic digits", "رمز ٤٨٢٩١٣"],
    ["password with a dash dropped", "pw hunter2secret"],
  ];
  it.each(HIDDEN)("masks a secret: %s", (_n, text) => {
    expect(s.scrub(text)).toContain(SECURE_MASK);
    expect(s.scrub(text).replace(/\D/g, "")).not.toContain("482913");
  });
  it("leaves other numbers alone", () => {
    expect(s.scrub("code 319284")).toBe("code 319284");
    // Not inside a longer number.
    expect(s.scrub("order 14829135")).toBe("order 14829135");
  });
  const CARDS: [string, string][] = [
    ["spaces", "4242 4242 4242 4242"],
    ["double spaces", "4242  4242  4242  4242"],
    ["thin spaces", "4242 4242 4242 4242"],
    ["dots", "4242.4242.4242.4242"],
    ["zero-width", "4242​4242​4242​4242"],
    ["slashes", "4242/4242/4242/4242"],
    ["dashes", "4242-4242-4242-4242"],
    ["fullwidth", "４２４２ ４２４２ ４２４２ ４２４２"],
    ["one block after a hash", "Order #4242424242424242"],
    ["Amex 4-6-5", "3782 822463 10005"],
    ["after a short number", "row 5 4242 4242 4242 4242"],
  ];
  it.each(CARDS)("masks a Luhn-valid card number: %s", (_n, text) => {
    const out = maskCardNumbers(text, SECURE_MASK);
    expect(out).toContain(SECURE_MASK);
    expect(out).not.toMatch(/4242|３７８２|822463/);
  });
  const MORE: [string, string][] = [
    ["mathematical bold digits", "code 𝟒𝟖𝟐𝟗𝟏𝟑"],
    ["Bengali digits", "code ৪৮২৯১৩"],
    ["pipes", "4|8|2|9|1|3"],
    ["underscores", "4 _ 8 _ 2 _ 9 _ 1 _ 3"],
    ["commas", "4,829,13"],
    ["middle dots", "4·8·2·9·1·3"],
  ];
  it.each(MORE)("masks a secret: %s", (_n, text) => {
    expect(s.scrub(text)).toContain(SECURE_MASK);
  });
  const MORE_CARDS: [string, string][] = [
    ["math bold", "𝟒𝟐𝟒𝟐 𝟒𝟐𝟒𝟐 𝟒𝟐𝟒𝟐 𝟒𝟐𝟒𝟐"],
    ["underscores", "4242_4242_4242_4242"],
    ["commas", "4242,4242,4242,4242"],
    ["pipes", "4242 | 4242 | 4242 | 4242"],
  ];
  it.each(MORE_CARDS)("masks a card number: %s", (_n, text) => {
    expect(maskCardNumbers(text, SECURE_MASK)).toBe(SECURE_MASK);
  });
  it("a value longer than the cap is not tracked (the page fails closed instead)", () => {
    const long = "x".repeat(MAX_SECRET_CHARS + 1);
    expect(makeScrubber([long], SECURE_MASK).scrub(long)).toBe(long);
  });
  it("fail-closed mode masks every run of four or more digits", () => {
    const f = makeScrubber([], SECURE_MASK, { failClosed: true });
    expect(f.scrub("Your code is 482913")).toBe(`Your code is ${SECURE_MASK}`);
    expect(f.scrub("4 8 2 9 1 3")).toBe(SECURE_MASK);
    expect(f.scrub("Step 2 of 3")).toBe("Step 2 of 3");
  });
  it("keeps numbers that are not cards", () => {
    for (const t of [
      "4242 4242 4242 4241",
      "Call 555 123 4567",
      "1 2 3 4 5 6 7 8 9 10 11 12 13 14",
      "12345678901234567890123",
    ]) {
      expect(maskCardNumbers(t, SECURE_MASK)).toBe(t);
    }
  });
});

describe("URL redaction of secret keys", () => {
  const KEYS = [
    "otp_code",
    "verification_code",
    "totp",
    "mfa_code",
    "passcode",
    "one_time_code",
    "pin",
    "pan",
    "cc",
    "cvc2",
    "user[password]",
    "sms_code",
    "emailCode",
  ];
  it.each(KEYS)("masks %s", (k) => {
    const out = redactUrl(`https://a.example/x?${encodeURIComponent(k)}=909090&page=2`);
    expect(out).not.toContain("909090");
    expect(out).toContain("page=2");
  });
  it("keeps ordinary parameters", () => {
    expect(redactUrl("https://a.example/x?q=pins&sort=asc&country_code=US")).toBe(
      "https://a.example/x?q=pins&sort=asc&country_code=US",
    );
  });
});

// --- hand-built AX + DOM fixtures: each new mechanism has a test that fails without it -------------

interface N {
  tag: string;
  attrs?: Record<string, string>;
  parent?: number;
  value?: string;
  /** A text node (nodeType 3). */
  text?: string;
}

function mkDom(nodes: N[]): CaptureSnapshotResult {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const s = (v: string): number => {
    const i = index.get(v);
    if (i !== undefined) return i;
    strings.push(v);
    index.set(v, strings.length - 1);
    return strings.length - 1;
  };
  const doc = {
    documentURL: s("https://shop.example/"),
    title: s("Shop"),
    frameId: s("main"),
    nodes: {
      parentIndex: [] as number[],
      nodeType: [] as number[],
      nodeName: [] as number[],
      nodeValue: [] as number[],
      backendNodeId: [] as number[],
      attributes: [] as number[][],
      inputValue: { index: [] as number[], value: [] as number[] },
      inputChecked: { index: [] as number[] },
      contentDocumentIndex: { index: [] as number[], value: [] as number[] },
      isClickable: { index: [] as number[] },
    },
    layout: { nodeIndex: [] as number[], bounds: [] as number[][] },
  };
  nodes.forEach((n, i) => {
    doc.nodes.parentIndex.push(n.parent ?? -1);
    doc.nodes.nodeType.push(n.text !== undefined ? 3 : 1);
    doc.nodes.nodeName.push(s(n.text !== undefined ? "#text" : n.tag));
    doc.nodes.nodeValue.push(n.text !== undefined ? s(n.text) : -1);
    doc.nodes.backendNodeId.push(i + 1);
    doc.nodes.attributes.push(Object.entries(n.attrs ?? {}).flatMap(([k, v]) => [s(k), s(v)]));
    if (n.value !== undefined) {
      doc.nodes.inputValue.index.push(i);
      doc.nodes.inputValue.value.push(s(n.value));
    }
    if (n.text === undefined) {
      doc.layout.nodeIndex.push(i);
      doc.layout.bounds.push([0, i * 20, 300, 18]);
    }
  });
  return { strings, documents: [doc] };
}

const ax = (
  id: number,
  role: string,
  name: string,
  childIds: number[] = [],
  dom?: number,
  parent?: number,
  value?: string,
): AXNode => {
  const n: AXNode = {
    nodeId: String(id),
    ignored: false,
    role: { type: "role", value: role },
    name: { type: "computedString", value: name },
    childIds: childIds.map(String),
  };
  if (dom !== undefined) n.backendDOMNodeId = dom;
  if (parent !== undefined) n.parentId = String(parent);
  if (value !== undefined) n.value = { type: "string", value };
  return n;
};

const VIEWPORT = { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 800 };
const snap = (axNodes: AXNode[], dom: CaptureSnapshotResult, extra: object = {}) => {
  const refs = new RefRegistry();
  refs.setDocument("doc");
  return buildSnapshot({
    url: "https://shop.example/",
    title: "Shop",
    ax: axNodes,
    dom,
    dpr: 1,
    viewport: VIEWPORT,
    refs,
    ...extra,
  });
};

describe("hidden-role skip: a secret field under a role the walker drops", () => {
  // DOM: 0 html, 1 body, 2 div[contenteditable] "Verification code", 3 text "123" (3 chars: the
  // value scrubber ignores it, so only the skip keeps it out).
  const dom = mkDom([
    { tag: "HTML" },
    { tag: "BODY", parent: 0 },
    {
      tag: "DIV",
      parent: 1,
      attrs: { contenteditable: "true", "aria-label": "Verification code" },
    },
    { text: "123", tag: "#text", parent: 2 },
  ]);
  const tree = [
    ax(1, "RootWebArea", "Shop", [2], 1),
    ax(2, "generic", "Verification code", [3], 3, 1),
    ax(3, "StaticText", "123", [], 4, 2),
  ];
  it("snapshot shows nothing of it and flags the secure field", () => {
    const s = snap(tree, dom);
    expect(s.text).not.toContain("123");
    expect(s.secureFieldActive).toBe(true);
  });
  it("read_text skips it by its DOM facts", () => {
    const t = extractText(tree, { dom: new DomIndex(dom, 1) });
    expect(t.text).not.toContain("123");
  });
  it("a look-alike contenteditable keeps its text", () => {
    const d2 = mkDom([
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "DIV", parent: 1, attrs: { contenteditable: "true", "aria-label": "Message body" } },
      { text: "123", tag: "#text", parent: 2 },
    ]);
    const t2 = [
      ax(1, "RootWebArea", "Shop", [2], 1),
      ax(2, "generic", "Message body", [3], 3, 1),
      ax(3, "StaticText", "123", [], 4, 2),
    ];
    expect(extractText(t2, { dom: new DomIndex(d2, 1) }).text).toContain("123");
  });
});

describe("depth-cap guard: a secret deeper than maxDepth still refuses screenshots", () => {
  // A chain of 8 groups, then a textbox holding a value, labelled only by a <label for>.
  const chain = 8;
  const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }];
  for (let i = 0; i < chain; i++) nodes.push({ tag: "DIV", parent: nodes.length - 1 });
  const holder = nodes.length - 1;
  nodes.push({
    tag: "INPUT",
    parent: holder,
    attrs: { id: "f9", name: "f9", type: "text" },
    value: "445566",
  });
  nodes.push({ tag: "LABEL", parent: holder, attrs: { for: "f9" } });
  nodes.push({ text: "Verification code", tag: "#text", parent: nodes.length - 1 });
  const dom = mkDom(nodes);
  const axNodes: AXNode[] = [ax(1, "RootWebArea", "Shop", [2], 1)];
  for (let i = 0; i < chain; i++) {
    axNodes.push(ax(2 + i, "group", `g${i}`, [3 + i], 3 + i, 1 + i));
  }
  axNodes[axNodes.length - 1] = ax(chain + 1, "group", "g", [chain + 2], chain + 2, chain);
  axNodes.push(ax(chain + 2, "textbox", "", [], chain + 3, chain + 1, "445566"));

  it("flags the field beyond the cap", () => {
    const s = snap(axNodes, dom, { options: { maxDepth: 3 } });
    expect(s.text).toContain("TRUNCATED(maxDepth)");
    expect(s.text).not.toContain("445566");
    expect(s.secureFieldActive).toBe(true);
  });
  it("a look-alike (no secret label) beyond the cap does not", () => {
    const nodes2 = nodes.map((n) => ({ ...n }));
    nodes2[nodes2.length - 1] = { text: "Search notes", tag: "#text", parent: nodes2.length - 2 };
    const s = snap(axNodes, mkDom(nodes2), { options: { maxDepth: 3 } });
    expect(s.secureFieldActive).toBe(false);
  });
});

describe("value backstop", () => {
  const digits = ["4", "8", "2", "9", "1", "3"];
  // input-otp pattern: one transparent input plus a div per typed digit.
  const nodes: N[] = [
    { tag: "HTML" },
    { tag: "BODY", parent: 0 },
    {
      tag: "INPUT",
      parent: 1,
      attrs: { name: "x", autocomplete: "one-time-code" },
      value: "482913",
    },
  ];
  for (const d of digits) {
    nodes.push({ tag: "DIV", parent: 1 });
    nodes.push({ text: d, tag: "#text", parent: nodes.length - 1 });
  }
  const dom = mkDom(nodes);
  const tree: AXNode[] = [
    ax(1, "RootWebArea", "Shop", [2, ...digits.map((_d, i) => 10 + i)], 1),
    ax(2, "textbox", "Code", [], 3, 1, "482913"),
    ...digits.map((d, i) => ax(10 + i, "StaticText", d, [], 5 + i * 2, 1)),
  ];
  it("masks per-digit text nodes in the snapshot", () => {
    const s = snap(tree, dom);
    expect(s.text).not.toMatch(/text "4"/);
    expect(s.text).not.toContain("482913");
    expect(s.text).toContain(`- text "${SECURE_MASK}"`);
  });
  it("masks them in read_text", () => {
    const t = extractText(tree, { dom: new DomIndex(dom, 1) });
    expect(t.text).not.toMatch(/4\s*8\s*2\s*9\s*1\s*3/);
  });
  it("masks a Luhn-valid number in a field the classifier misses, and flags it", () => {
    const card = ["4242", "4242", "4242", "4242"].join(" ");
    const d = mkDom([
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "INPUT", parent: 1, attrs: { name: "memo", type: "text" }, value: card },
      { tag: "P", parent: 1 },
      { text: `paid with ${card}`, tag: "#text", parent: 3 },
    ]);
    const t = [
      ax(1, "RootWebArea", "Shop", [2, 3], 1),
      ax(2, "textbox", "Memo", [], 3, 1, card),
      ax(3, "StaticText", `paid with ${card}`, [], 5, 1),
    ];
    const s = snap(t, d);
    expect(s.text).not.toContain("4242");
    // The Luhn branch of the classification: the field itself is marked secure.
    expect(s.text).toMatch(/textbox "Memo" \[ref=ref_\d+\] \[secure\] value="•••"/);
    expect(s.refs.find((r) => r.name === "Memo")?.states).toContain("secure");
    expect(s.secureFieldActive).toBe(true);
    expect(extractText(t, { dom: new DomIndex(d, 1) }).text).not.toContain("4242");
  });
  it("keeps the look-alike value", () => {
    const d = mkDom([
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "INPUT", parent: 1, attrs: { name: "hint", type: "text" }, value: "first pet" },
    ]);
    const s = snap(
      [
        ax(1, "RootWebArea", "Shop", [2], 1),
        ax(2, "textbox", "Password hint", [], 3, 1, "first pet"),
      ],
      d,
    );
    expect(s.text).toContain("first pet");
    expect(s.secureFieldActive).toBe(false);
  });
});

// --- review round 2: slot widgets, split boxes, weak screenshots, fail closed, perf ----------------

/** The input-otp pattern: one input holding `value`, and the digits drawn under two groups. */
function slotPage(value: string, groupName = "") {
  const digits = [...value];
  const nodes: N[] = [
    { tag: "HTML" },
    { tag: "BODY", parent: 0 },
    {
      tag: "INPUT",
      parent: 1,
      attrs: { name: "x", autocomplete: "one-time-code" },
      value,
    },
    { tag: "DIV", parent: 1, attrs: { role: "group", "aria-label": groupName } },
    { tag: "DIV", parent: 1, attrs: { role: "group" } },
  ];
  const domIds: number[] = [];
  for (const [i, d] of digits.entries()) {
    nodes.push({ tag: "DIV", parent: i < 3 ? 3 : 4 });
    nodes.push({ text: d, tag: "#text", parent: nodes.length - 1 });
    domIds.push(nodes.length);
  }
  const tree: AXNode[] = [
    ax(1, "RootWebArea", "Shop", [2, 20, 21], 1),
    ax(2, "textbox", "Code", [], 3, 1, value),
    ax(20, "group", groupName, [10, 11, 12], 4, 1),
    ax(21, "group", "", [13, 14, 15], 5, 1),
    ...digits.map((d, i) => ax(10 + i, "StaticText", d, [], domIds[i], i < 3 ? 20 : 21)),
  ];
  return { dom: mkDom(nodes), tree };
}

describe("slot-rendered secrets in the snapshot", () => {
  it("masks digits split over two unnamed groups", () => {
    const { dom, tree } = slotPage("482913");
    const s = snap(tree, dom);
    expect(s.text).not.toMatch(/text "[0-9]"/);
    expect(s.text).toContain(`- text "${SECURE_MASK}"`);
    expect(extractText(tree, { dom: new DomIndex(dom, 1) }).text).not.toMatch(/\d/);
  });
  it("keeps a slot digit that the group's name also contains", () => {
    // "6" is in "Enter the 6-digit code": the name dedupe used to drop it and break the run.
    // The "6" slot sits in the group named "Enter the 6-digit code".
    const { dom, tree } = slotPage("648291", "Enter the 6-digit code");
    const s = snap(tree, dom);
    expect(s.text).not.toMatch(/text "[0-9]"/);
  });
  it("masks a card number drawn in four spans", () => {
    const parts = ["4242", "4242", "4242", "4242"];
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }, { tag: "P", parent: 1 }];
    for (const p of parts) {
      nodes.push({ tag: "SPAN", parent: 2 });
      nodes.push({ text: p, tag: "#text", parent: nodes.length - 1 });
    }
    const tree: AXNode[] = [
      ax(1, "RootWebArea", "Card", [20], 1),
      ax(20, "paragraph", "", [10, 11, 12, 13], 3, 1),
      ...parts.map((p, i) => ax(10 + i, "StaticText", p, [], 5 + i * 2, 20)),
    ];
    expect(snap(tree, mkDom(nodes)).text).not.toContain("4242");
  });
  it("keeps short text runs that are not a secret", () => {
    const { dom, tree } = slotPage("482913");
    (tree[3] as AXNode).name = { type: "computedString", value: "7" };
    const nodes = [ax(1, "RootWebArea", "Shop", [2, 3, 4], 1)];
    const t2 = [
      ...nodes,
      ax(2, "StaticText", "1", [], 6, 1),
      ax(3, "StaticText", "of", [], 8, 1),
      ax(4, "StaticText", "3", [], 10, 1),
    ];
    const s = snap(t2, dom);
    expect(s.text).toContain('text "of"');
    expect(s.text).toContain('text "3"');
  });
});

describe("split OTP boxes: four or more one-character inputs", () => {
  const boxes = (count: number, names: (i: number) => string, values: string[]) => {
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }, { tag: "DIV", parent: 1 }];
    const tree: AXNode[] = [ax(1, "RootWebArea", "Verify", [], 1)];
    for (let i = 0; i < count; i++) {
      // Each box in its own wrapper div, as most widgets draw them.
      nodes.push({ tag: "DIV", parent: 2 });
      nodes.push({
        tag: "INPUT",
        parent: nodes.length - 1,
        attrs: { name: names(i), maxlength: "1", type: "text" },
        value: values[i] ?? "",
      });
      tree.push(ax(10 + i, "textbox", "", [], nodes.length, 1, values[i] ?? ""));
      (tree[0] as AXNode).childIds?.push(String(10 + i));
    }
    tree.push(ax(99, "StaticText", "We sent 482913 to you", [], 1, 1));
    (tree[0] as AXNode).childIds?.push("99");
    return { dom: mkDom(nodes), tree };
  };
  it("masks every box and the joined code, and refuses screenshots", () => {
    const { dom, tree } = boxes(6, (i) => `f${i}`, [..."482913"]);
    const s = snap(tree, dom);
    expect(s.text).not.toMatch(/value="[0-9]"/);
    expect(s.text).not.toContain("482913");
    expect(s.secureFieldActive).toBe(true);
    expect(new DomIndex(dom, 1).anySecureValue()).toBe(true);
  });
  it("otp1..otp6 boxes are secret by name too", () => {
    const { dom, tree } = boxes(2, (i) => `otp${i + 1}`, ["4", "8"]);
    expect(snap(tree, dom).text).not.toMatch(/value="[0-9]"/);
  });
  it("three one-character inputs are not a split OTP", () => {
    const { dom, tree } = boxes(3, (i) => `initial${i}`, ["A", "B", "C"]);
    const s = snap(tree, dom);
    expect(s.text).toContain('value="A"');
    expect(s.secureFieldActive).toBe(false);
  });
});

describe("weak fields refuse screenshots only for a secret-shaped value", () => {
  const one = (label: string, name: string, value: string) => {
    const dom = mkDom([
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "INPUT", parent: 1, attrs: { name, type: "text", "aria-label": label }, value },
    ]);
    const tree = [ax(1, "RootWebArea", "Shop", [2], 1), ax(2, "textbox", label, [], 3, 1, value)];
    return { s: snap(tree, dom), guard: new DomIndex(dom, 1).anySecureValue() };
  };
  const ROWS: [string, string, string, boolean][] = [
    ["Enter the code we sent", "code", "482913", true],
    ["Digit 1", "d1", "4", true],
    ["PIN", "pin", "1234", true],
    ["Expiration date", "exp", "12/29", true],
    ["PAN", "pan", "ABCDE1234F", true],
    ["Enter code", "code", "SPRING-SALE", false],
    // "we sent" makes it a strong OTP: any value, letter codes too (Steam Guard "5X9KQ").
    ["Enter the code we sent", "code", "5X9KQ", true],
    ["Expiration date", "exp", "2029-12-01", false],
  ];
  it.each(ROWS)("%s = %s", (label, name, value, blocks) => {
    const { s, guard } = one(label, name, value);
    expect(s.text).not.toContain(`value="${value}"`);
    expect(s.text).toContain(`value="${SECURE_MASK}"`);
    expect(s.secureFieldActive).toBe(blocks);
    // The DOM-only guard (after the capture, beyond the depth cap) agrees.
    expect(guard).toBe(blocks);
  });
  const AX_ONLY: [string, string, boolean][] = [
    ["Enter the code we sent", "482913", true],
    ["Digit 1", "4", true],
    ["Expiration date", "12/29", true],
    ["Enter code", "SPRING-SALE", false],
  ];
  it.each(AX_ONLY)("label only in the AX tree: %s = %s", (label, value, blocks) => {
    // The DOM has no label at all, so only the AX walk can judge the field.
    const dom = mkDom([
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "INPUT", parent: 1, attrs: { name: "f1", type: "text" }, value },
    ]);
    const tree = [ax(1, "RootWebArea", "Shop", [2], 1), ax(2, "textbox", label, [], 3, 1, value)];
    expect(new DomIndex(dom, 1).anySecureValue()).toBe(false);
    const s = snap(tree, dom);
    expect(s.text).toContain(`value="${SECURE_MASK}"`);
    expect(s.secureFieldActive).toBe(blocks);
  });
});

describe("review round 3: fail closed, revealed passwords, hidden roles, errors", () => {
  it("over the cap, echoes and slot digits in text are masked too", () => {
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }];
    const tree: AXNode[] = [ax(1, "RootWebArea", "Bulk", [], 1)];
    for (let i = 0; i <= MAX_SECRETS; i++) {
      nodes.push({
        tag: "INPUT",
        parent: 1,
        attrs: { name: `pin_${i}` },
        value: String(100000 + i),
      });
      tree.push(ax(10 + i, "textbox", "PIN", [], nodes.length, 1, String(100000 + i)));
    }
    nodes.push({ tag: "SPAN", parent: 1 });
    nodes.push({ text: "Your code is 482913", tag: "#text", parent: nodes.length - 1 });
    tree.push(ax(5000, "StaticText", "Your code is 482913", [], nodes.length, 1));
    for (const [i, d] of [..."482913"].entries()) {
      nodes.push({ tag: "DIV", parent: 1 });
      nodes.push({ text: d, tag: "#text", parent: nodes.length - 1 });
      tree.push(ax(6000 + i, "StaticText", d, [], nodes.length, 1));
    }
    (tree[0] as AXNode).childIds = tree.slice(1).map((n) => n.nodeId);
    const dom = mkDom(nodes);
    expect(new DomIndex(dom, 1).overCap).toBe(true);
    const sn = snap(tree, dom);
    expect(sn.text).not.toContain("482913");
    expect(sn.text).not.toMatch(/text "[0-9]"/);
    expect(sn.secureFieldActive).toBe(true);
    expect(extractText(tree, { dom: new DomIndex(dom, 1) }).text).not.toMatch(
      /4\D*8\D*2\D*9\D*1\D*3/,
    );
  });
  it("many expiry inputs holding dates do not trip the cap (only secret-shaped values count)", () => {
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }];
    for (let i = 0; i < MAX_SECRETS + 10; i++) {
      nodes.push({
        tag: "INPUT",
        parent: 1,
        attrs: { name: `batch_expiry_${i}`, "aria-label": "Expiration date" },
        // Distinct dates, so more than MAX_SECRETS distinct values reach the cap check.
        value: `${2030 + Math.floor(i / 28)}-12-${String((i % 28) + 1).padStart(2, "0")}`,
      });
    }
    const d = new DomIndex(mkDom(nodes), 1);
    expect(d.overCap).toBe(false);
    expect(d.anySecureValue()).toBe(false);
  });
  it("a 6,000-character secret neither throws nor leaks, and fails closed", () => {
    const long = Array.from({ length: 6000 }, (_, i) =>
      String.fromCharCode(97 + ((i * 7) % 26)),
    ).join("");
    const dom = mkDom([
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "INPUT", parent: 1, attrs: { type: "password", name: "p" }, value: "hunter2!Secret" },
      { tag: "TEXTAREA", parent: 1, attrs: { name: "recovery_codes" }, value: long },
      { tag: "P", parent: 1 },
      { text: "echo 482913", tag: "#text", parent: 4 },
    ]);
    const tree = [
      ax(1, "RootWebArea", "Shop", [2, 3, 4], 1),
      ax(2, "textbox", "Password", [], 3, 1, "hunter2!Secret"),
      ax(3, "textbox", "Recovery codes", [], 4, 1, long),
      ax(4, "StaticText", "echo 482913", [], 6, 1),
    ];
    const sn = snap(tree, dom);
    expect(sn.text).not.toContain("hunter2");
    // The value is masked as a field; past the cap, text fails closed on digit runs.
    expect(sn.text).not.toContain(long.slice(0, 40));
    expect(new DomIndex(dom, 1).overCap).toBe(true);
    expect(sn.text).not.toContain("482913");
    expect(sn.secureFieldActive).toBe(true);
    expect(extractText(tree, { dom: new DomIndex(dom, 1) }).text).not.toContain("hunter2");
  });
  it("a secret under a dropped role, labelled only in the AX tree, refuses screenshots", () => {
    // The contenteditable has no label in the DOM: only the walk's hidden-role branch sees it.
    const dom = mkDom([
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "DIV", parent: 1, attrs: { contenteditable: "true" } },
      { text: "482913", tag: "#text", parent: 2 },
    ]);
    const tree = [
      ax(1, "RootWebArea", "Shop", [2], 1),
      ax(2, "generic", "Verification code", [3], 3, 1),
      ax(3, "StaticText", "482913", [], 4, 2),
    ];
    expect(new DomIndex(dom, 1).anySecureValue()).toBe(false);
    const sn = snap(tree, dom);
    expect(sn.text).not.toContain("482913");
    expect(sn.secureFieldActive).toBe(true);
  });
  it("a password field revealed as text stays a password (and refuses typing)", () => {
    const pw = (type: string) =>
      mkDom([
        { tag: "HTML" },
        { tag: "BODY", parent: 0 },
        { tag: "INPUT", parent: 1, attrs: { type, name: "f1", id: "f1" }, value: "correct horse" },
      ]);
    const tree = [
      ax(1, "RootWebArea", "Shop", [2], 1),
      ax(2, "textbox", "Notes", [], 3, 1, "correct horse"),
    ];
    const seen = new Set<number>();
    expect(snap(tree, pw("password"), { wasPassword: seen }).text).not.toContain("correct horse");
    expect([...seen]).toEqual([3]);
    // The page's reveal toggle sets type=text: the same node is still masked.
    const revealed = snap(tree, pw("text"), { wasPassword: seen });
    expect(revealed.text).not.toContain("correct horse");
    expect(revealed.secureFieldActive).toBe(true);
    // Without the memory it would show.
    expect(snap(tree, pw("text")).text).toContain("correct horse");
  });
  it("a crossword grid of one-character inputs is not a split OTP", () => {
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }, { tag: "TABLE", parent: 1 }];
    const tree: AXNode[] = [ax(1, "RootWebArea", "Puzzle", [], 1)];
    for (let r = 0; r < 5; r++) {
      nodes.push({ tag: "TR", parent: 2 });
      const row = nodes.length - 1;
      for (let c = 0; c < 5; c++) {
        nodes.push({ tag: "TD", parent: row });
        nodes.push({
          tag: "INPUT",
          parent: nodes.length - 1,
          attrs: { maxlength: "1", name: `c${r}${c}` },
          value: "A",
        });
        tree.push(ax(100 + r * 5 + c, "textbox", "", [], nodes.length, 1, "A"));
      }
    }
    (tree[0] as AXNode).childIds = tree.slice(1).map((n) => n.nodeId);
    const sn = snap(tree, mkDom(nodes));
    expect(sn.text).toContain('value="A"');
    expect(sn.secureFieldActive).toBe(false);
  });
  it("a weak code field holding Arabic-Indic digits refuses screenshots", () => {
    const v = "٤٨٢٩١٣";
    const dom = mkDom([
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "INPUT", parent: 1, attrs: { name: "code", "aria-label": "Enter code" }, value: v },
    ]);
    expect(new DomIndex(dom, 1).anySecureValue()).toBe(true);
  });
  it("a card number in two nine-character spans is masked", () => {
    const tree: AXNode[] = [
      ax(1, "RootWebArea", "Card", [20], 1),
      ax(20, "paragraph", "", [10, 11], 3, 1),
      ax(10, "StaticText", "4242 4242", [], 5, 20),
      ax(11, "StaticText", "4242 4242", [], 7, 20),
    ];
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }, { tag: "P", parent: 1 }];
    expect(snap(tree, mkDom(nodes)).text).not.toContain("4242");
  });
});

describe(`more than ${MAX_SECRETS} secret values: fail closed`, () => {
  const page = (count: number) => {
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }];
    const tree: AXNode[] = [ax(1, "RootWebArea", "Bulk", [], 1)];
    for (let i = 0; i < count; i++) {
      nodes.push({
        tag: "INPUT",
        parent: 1,
        attrs: { name: `pin_${i}`, type: "text" },
        value: String(100000 + i),
      });
      tree.push(ax(10 + i, "textbox", "PIN", [], nodes.length, 1, String(100000 + i)));
    }
    nodes.push({
      tag: "INPUT",
      parent: 1,
      attrs: { name: "title", type: "text" },
      value: "Q3 plan",
    });
    tree.push(ax(5000, "textbox", "Title", [], nodes.length, 1, "Q3 plan"));
    (tree[0] as AXNode).childIds = tree.slice(1).map((n) => n.nodeId);
    return { dom: mkDom(nodes), tree };
  };
  it("under the cap, ordinary fields keep their values", () => {
    const { dom, tree } = page(MAX_SECRETS);
    const d = new DomIndex(dom, 1);
    expect(d.overCap).toBe(false);
    expect(snap(tree, dom).text).toContain("Q3 plan");
  });
  it("over the cap, every field value is masked and screenshots are refused", () => {
    const { dom, tree } = page(MAX_SECRETS + 1);
    const d = new DomIndex(dom, 1);
    expect(d.overCap).toBe(true);
    expect(d.anySecureValue()).toBe(true);
    const s = snap(tree, dom);
    expect(s.text).not.toContain("Q3 plan");
    expect(s.text).not.toMatch(/1000\d\d/);
    expect(s.secureFieldActive).toBe(true);
  });
});

describe("read_text without a DOM index", () => {
  it("still masks card numbers", () => {
    const tree = [
      ax(1, "RootWebArea", "Card", [2], 1),
      ax(2, "StaticText", "Your card 4242 4242 4242 4242", [], 4, 1),
    ];
    expect(extractText(tree, {}).text).toBe(`Your card ${SECURE_MASK}`);
  });
  it("counts ignored nodes as field candidates (the walk passes through them)", () => {
    const n = ax(2, "textbox", "Verification code", [], 3, 1, "482913");
    n.ignored = true;
    expect(hasFieldCandidates([[ax(1, "RootWebArea", "x", [2], 1), n]])).toBe(true);
    expect(
      hasFieldCandidates([
        [ax(1, "RootWebArea", "x", [3], 1), ax(3, "StaticText", "hi", [], 4, 1)],
      ]),
    ).toBe(false);
  });
});

describe("perf: a big page stays linear (a hostile page must not freeze the Gateway)", () => {
  /** N nodes; F filled inputs, each with an id and a `<label for>`; text rows with digits. */
  /** Field values of mixed lengths (4-40 characters). */
  const mixed = (i: number): string =>
    `${(i * 7919 + 1000).toString(36)}`.repeat(1 + (i % 9)).slice(0, 40);
  const bigPage = (N: number, F: number, fieldName: (i: number) => string | undefined) => {
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }];
    const tree: AXNode[] = [ax(1, "RootWebArea", "Big", [], 1)];
    const kids: number[] = [];
    for (let i = 0; i < F; i++) {
      const name = fieldName(i);
      if (name === undefined) {
        nodes.push({ tag: "DIV", parent: 1 });
        nodes.push({ tag: "DIV", parent: 1 });
        nodes.push({ text: `Title ${i}`, tag: "#text", parent: nodes.length - 1 });
        tree.push(ax(nodes.length + 10, "StaticText", `Title ${i}`, [], nodes.length, 1));
      } else {
        nodes.push({
          tag: "INPUT",
          parent: 1,
          attrs: { id: `f${i}`, name, type: "text" },
          value: mixed(i),
        });
        tree.push(ax(nodes.length + 10, "textbox", "Title", [], nodes.length, 1, mixed(i)));
        nodes.push({ tag: "LABEL", parent: 1, attrs: { for: `f${i}` } });
        nodes.push({ text: `Title ${i}`, tag: "#text", parent: nodes.length - 1 });
      }
      kids.push(nodes.length + 10 - (name === undefined ? 0 : 2));
    }
    while (nodes.length < N) {
      nodes.push({ tag: "DIV", parent: 1 });
      nodes.push({ text: `row ${nodes.length} 4242 4242`, tag: "#text", parent: nodes.length - 1 });
      tree.push(
        ax(nodes.length + 10, "StaticText", `row ${nodes.length} 4242 4242`, [], nodes.length, 1),
      );
    }
    (tree[0] as AXNode).childIds = tree.slice(1).map((n) => n.nodeId);
    return { dom: mkDom(nodes), tree };
  };
  /** Best of five, round-robin, so a load spike from other work hits every variant alike. */
  const bestOf = (fs: (() => void)[]): number[] => {
    const ms = fs.map(() => Number.POSITIVE_INFINITY);
    for (let k = 0; k < 5; k++) {
      fs.forEach((f, i) => {
        const t = performance.now();
        f();
        ms[i] = Math.min(ms[i] as number, performance.now() - t);
      });
    }
    return ms;
  };
  const run = (p: { dom: CaptureSnapshotResult; tree: AXNode[] }) => () => {
    snap(p.tree, p.dom);
    extractText(p.tree, { dom: new DomIndex(p.dom, 1), maxChars: 200_000 });
    new DomIndex(p.dom, 1).anySecureValue();
  };
  it("100k nodes with 4,000 filled inputs: within 3x of the same page without fields", () => {
    const N = 100_000;
    const F = 4000;
    const [base, fields, masked, allMasked] = bestOf([
      // The same node count and text, the inputs replaced by plain text: the per-node cost alone.
      run(bigPage(N, F, () => undefined)),
      run(bigPage(N, F, (i) => `title_${i}`)),
      // Secret values just under the cap: the combined scrubber runs over every string.
      run(bigPage(N, F, (i) => (i < MAX_SECRETS ? `otp_${i}` : `title_${i}`))),
      // Every field a secret: over the cap, so nothing is tracked and the page fails closed.
      run(bigPage(N, F, (i) => `otp_${i}`)),
    ]) as [number, number, number, number];
    const budget = Math.max(3 * base, 150);
    const seen = `base ${base.toFixed(0)} ms, fields ${fields.toFixed(0)} ms, masked ${masked.toFixed(0)} ms, all masked ${allMasked.toFixed(0)} ms`;
    if (process.env.PSYCHE_PERF_LOG === "1") console.log(seen);
    expect(fields, seen).toBeLessThan(budget);
    expect(masked, seen).toBeLessThan(budget);
    expect(allMasked, seen).toBeLessThan(budget);
    // Before the fix this page took 5.8 s (fields) and 36 s (masked) per snapshot.
    expect(Math.max(fields, masked, allMasked)).toBeLessThan(3000);
  }, 120_000);
});

describe("perf: the review's worst-case pages (round 3)", () => {
  /** `type=password` fields holding `secrets`, then one span per text. */
  const page = (secrets: string[], texts: string[]) => {
    const nodes: N[] = [{ tag: "HTML" }, { tag: "BODY", parent: 0 }];
    const tree: AXNode[] = [ax(1, "RootWebArea", "P", [], 1)];
    secrets.forEach((v, i) => {
      nodes.push({ tag: "INPUT", parent: 1, attrs: { type: "password", name: `p${i}` }, value: v });
      tree.push(ax(10 + tree.length, "textbox", "Password", [], nodes.length, 1, v));
    });
    for (const t of texts) {
      nodes.push({ tag: "SPAN", parent: 1 });
      nodes.push({ text: t, tag: "#text", parent: nodes.length - 1 });
      tree.push(ax(10 + tree.length, "StaticText", t, [], nodes.length, 1));
    }
    (tree[0] as AXNode).childIds = tree.slice(1).map((n) => n.nodeId);
    return { dom: mkDom(nodes), tree };
  };
  const ms = (f: () => void): number => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  const both = (p: { dom: CaptureSnapshotResult; tree: AXNode[] }) =>
    ms(() => {
      snap(p.tree, p.dom);
      extractText(p.tree, { dom: new DomIndex(p.dom, 1), maxChars: 200_000 });
    });
  it("one 4k-character secret beside 80k characters of its prefix (was 1.6 s)", () => {
    expect(both(page([`${"a".repeat(4000)}b`], ["a".repeat(80_000)]))).toBeLessThan(1500);
  });
  it("64 secrets of 200 characters sharing a prefix, beside 100k of it (was 46 s)", () => {
    const secrets = Array.from(
      { length: 64 },
      (_, i) => `${"a".repeat(200)}${String.fromCharCode(0x4e00 + i)}`,
    );
    expect(both(page(secrets, ["a".repeat(100_000)]))).toBeLessThan(1500);
  });
  it("a contenteditable with 50k text nodes (was ~4 s)", () => {
    const nodes: N[] = [
      { tag: "HTML" },
      { tag: "BODY", parent: 0 },
      { tag: "DIV", parent: 1, attrs: { contenteditable: "true", "aria-label": "Notes" } },
    ];
    for (let i = 0; i < 50_000; i++) {
      nodes.push({ tag: "P", parent: 2 });
      nodes.push({ text: `word${i} lorem ipsum dolor`, tag: "#text", parent: nodes.length - 1 });
    }
    const dom = mkDom(nodes);
    expect(ms(() => new DomIndex(dom, 1))).toBeLessThan(1500);
  });
  it("160k short spans of card digits (was 4.9 s), and 160k of letters (was a RangeError)", () => {
    expect(
      both(
        page(
          [],
          Array.from({ length: 160_000 }, () => "4242"),
        ),
      ),
    ).toBeLessThan(3000);
    const letters = page(
      [],
      Array.from({ length: 160_000 }, () => "abcd"),
    );
    expect(() => snap(letters.tree, letters.dom)).not.toThrow();
  });
});
