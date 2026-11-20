import { describe, expect, it } from "vitest";
import type { AXNode, CaptureSnapshotResult } from "../src/cdp/types.ts";
import { redactUrl } from "../src/origin/redact-url.ts";
import { buildSnapshot, extractText, SECURE_MASK } from "../src/snapshot/builder.ts";
import { DomIndex } from "../src/snapshot/dom.ts";
import { RefRegistry } from "../src/snapshot/refs.ts";
import {
  type FieldFacts,
  isLegacySecure,
  isSecureField,
  isStrongSecureField,
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
    ["Confirmation code", input({ label: "Confirmation code" }), undefined],
  ];
  it.each(LEVELS)("%s", (_n, f, level) => {
    expect(secureLevel(f)).toBe(level);
  });
  it("typing is refused only on the old criteria", () => {
    expect(isLegacySecure(input({ type: "password" }))).toBe(true);
    expect(isLegacySecure(input({ type: "text", autocomplete: "one-time-code" }))).toBe(true);
    expect(isLegacySecure(input({ name: "otp" }))).toBe(false);
    expect(isLegacySecure(input({ label: "Card security code" }))).toBe(false);
  });
  it("screenshots are refused only for the high-confidence subset", () => {
    expect(isStrongSecureField(input({ name: "otp" }))).toBe(true);
    expect(isStrongSecureField(input({ name: "code", label: "Enter code" }))).toBe(false);
    expect(isStrongSecureField(input({ name: "pin" }))).toBe(false);
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
  const s = (v: string): number => {
    const i = strings.indexOf(v);
    if (i >= 0) return i;
    strings.push(v);
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
