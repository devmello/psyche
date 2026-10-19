import { readFileSync } from "node:fs";
import { canonicalJSON } from "@psyche/audit";
import { type ApprovalKind, PsycheError } from "@psyche/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  bindingFor,
  bindingHash,
  CREDENTIAL_FILL_FIELDS,
  canonicalEmail,
  canonicalOrigin,
  canonicalPath,
  canonicalUrl,
  DEDICATED_BINDING_KINDS,
  genericBindingFor,
  grantKeyHash,
  isDangerousLookalike,
} from "../src/index.ts";

/**
 * Binding hashes and grant keys (security §3.5, data model §4.2, S23 design-10/11/13/14).
 *
 * Section 1 is property-based: for every kind with a dedicated builder, valid arguments are
 * generated, then each bound field is changed and the binding hash must change; the grant key must
 * change exactly when a grant-key field changes.
 */

type Args = Record<string, unknown>;

const RUNS = { numRuns: 200 };

// ---- arbitraries ------------------------------------------------------------------------------

const opt = <T>(arb: fc.Arbitrary<T>): fc.Arbitrary<T | undefined> =>
  fc.option(arb, { nil: undefined });

const shaArb = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((b) => `sha256:${Buffer.from(b).toString("hex")}`);
const ident = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);
const segment = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
const absPath = fc.array(segment, { minLength: 1, maxLength: 4 }).map((s) => `/${s.join("/")}`);
const argStr = fc.string({ unit: "grapheme", maxLength: 12 }).filter((s) => !s.includes("\0"));
const emailArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9]{1,8}$/),
    fc.stringMatching(/^[a-z]{1,8}$/),
    fc.constantFrom("com", "org", "test"),
  )
  .map(([l, d, t]) => `${l}@${d}.${t}`);
const hostArb = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9]{0,7}$/), fc.constantFrom("com", "org", "test"))
  .map(([h, t]) => `${h}.${t}`);
/** Already-canonical origins: lowercase host, no default port. */
const originArb = fc
  .tuple(fc.constantFrom("http", "https"), hostArb, fc.constantFrom("", ":8080", ":8443"))
  .map(([s, h, p]) => `${s}://${h}${p}`);
const pathArb = fc
  .array(fc.stringMatching(/^[a-z0-9]{1,6}$/), { maxLength: 3 })
  .map((s) => `/${s.join("/")}`);
const queryArb = opt(fc.stringMatching(/^[a-z0-9]{1,6}$/)).map((q) =>
  q === undefined ? "" : `?q=${q}`,
);
const urlArb = fc.tuple(originArb, pathArb, queryArb).map(([o, p, q]) => `${o}${p}${q}`);
const attachmentArb = fc.record({
  sha256: shaArb,
  size: fc.nat({ max: 1_000_000_000 }),
  name: fc.string({ minLength: 1, maxLength: 12 }),
});
const dict = <T>(key: fc.Arbitrary<string>, value: fc.Arbitrary<T>, maxKeys: number) =>
  fc.dictionary(key, value, { maxKeys, noNullPrototype: true });

/** Test-side model of generated URLs (they are generated in canonical form). */
function originOf(u: string): string {
  const i = u.indexOf("/", u.indexOf("//") + 2);
  return i < 0 ? u : u.slice(0, i);
}
function pathOf(u: string): string {
  return u.slice(originOf(u).length).split("?")[0] ?? "/";
}

// ---- comparison helpers (test oracle, independent of the builders) ----------------------------

/** Raw canonical form; `undefined` (absent) differs from every present value. */
const canon = (x: unknown): string => canonicalJSON({ v: x });
const differs = (x: unknown, y: unknown): boolean => canon(x) !== canon(y);
const asList = (x: unknown): string[] => (x === undefined ? [] : (x as string[]));
const setKey = (x: unknown): string => JSON.stringify([...new Set(asList(x))].sort());
const attKey = (x: unknown): string =>
  JSON.stringify(
    ((x ?? []) as { sha256: string; size: number; name: string }[])
      .map((a) => `${a.sha256}:${a.size}:${a.name}`)
      .sort(),
  );
const recipients = (a: Args): string[] =>
  [...new Set([...asList(a.to), ...asList(a.cc), ...asList(a.bcc)])].sort();

// ---- the property harness ---------------------------------------------------------------------

interface Mutation {
  name: string;
  mutate: (a: Args) => fc.Arbitrary<Args>;
  /** Whether bindingHash changes (default true). */
  hash?: boolean;
  /** Whether grantKey changes. */
  grant: boolean | ((before: Args, after: Args) => boolean);
}

/** Replace `name` with a generated value that `different` says is a real change. */
function field(
  name: string,
  arb: fc.Arbitrary<unknown>,
  grant: Mutation["grant"],
  different: (before: unknown, after: unknown) => boolean = differs,
  hash = true,
): Mutation {
  return {
    name,
    hash,
    grant,
    mutate: (a) => arb.filter((v) => different(a[name], v)).map((v) => ({ ...a, [name]: v })),
  };
}

function describeMutations(kind: ApprovalKind, base: fc.Arbitrary<Args>, mutations: Mutation[]) {
  it(`${kind}: valid arguments build a deterministic binding`, () => {
    fc.assert(
      fc.property(base, (a) => {
        const x = bindingFor(kind, a);
        const y = bindingFor(kind, structuredClone(a));
        expect(y.bindingHash).toBe(x.bindingHash);
        expect(y.grantKey).toBe(x.grantKey);
        expect(x.bindingHash).toBe(bindingHash(kind, x.fields));
        expect(x.grantKey).toBe(grantKeyHash(kind, x.grantFields));
      }),
      RUNS,
    );
  });
  for (const m of mutations) {
    const hash = m.hash !== false;
    const grantText =
      typeof m.grant === "function"
        ? "grantKey as expected"
        : `grantKey ${m.grant ? "changes" : "stays"}`;
    it(`${kind}: ${m.name} → bindingHash ${hash ? "changes" : "stays"}, ${grantText}`, () => {
      fc.assert(
        fc.property(
          base.chain((a) => m.mutate(a).map((b) => [a, b] as const)),
          ([a, b]) => {
            const x = bindingFor(kind, a);
            const y = bindingFor(kind, b);
            if (hash) expect(y.bindingHash).not.toBe(x.bindingHash);
            else expect(y.bindingHash).toBe(x.bindingHash);
            const grant = typeof m.grant === "function" ? m.grant(a, b) : m.grant;
            if (grant) expect(y.grantKey).not.toBe(x.grantKey);
            else expect(y.grantKey).toBe(x.grantKey);
          },
        ),
        RUNS,
      );
    });
  }
}

/** Throws a `PsycheError` with code `invalid_params` (a `TargetError` or a binding error). */
function invalidError(fn: () => unknown): PsycheError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(PsycheError);
  expect((caught as PsycheError).code).toBe("invalid_params");
  return caught as PsycheError;
}

function expectInvalid(fn: () => unknown): void {
  invalidError(fn);
}

/** Stricter form for the S23 design-13 cases: the message names canonicalization or the binding. */
function expectCanonicalReject(fn: () => unknown): void {
  expect(invalidError(fn).message).toMatch(/canonical|binding/);
}

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;

// ---- base arbitraries per kind ----------------------------------------------------------------

const envName = fc.stringMatching(/^[A-Z][A-Z0-9_]{0,8}$/);
const envArb = dict(envName, fc.string({ maxLength: 10 }), 4);
const cfgArb = dict(fc.stringMatching(/^\.?[a-z]{1,8}(\/[a-z]{1,6})?$/), shaArb, 3);

const execBase = (host: boolean): fc.Arbitrary<Args> =>
  fc.record({
    argv: fc.array(argStr, { minLength: 1, maxLength: 5 }),
    cwd: absPath,
    env: opt(envArb),
    executable: absPath,
    executableSha256: host ? shaArb : opt(shaArb),
    sandboxId: opt(ident),
    stdinSha256: opt(shaArb),
    network: opt(fc.constantFrom("none", "proxy")),
    cwdConfigHashes: opt(cfgArb),
  });

const execMutations = (host: boolean): Mutation[] => [
  field("argv", fc.array(argStr, { minLength: 1, maxLength: 5 }), true),
  field("cwd", absPath, true),
  // exec binds "the same four fields": the explicit env is part of the grant key.
  field("env", envArb, true, (x, y) => differs(x ?? {}, y)),
  field("executable", absPath, true),
  field("executableSha256", host ? shaArb : opt(shaArb), true),
  field("sandboxId", opt(ident), false),
  field("stdinSha256", opt(shaArb), false),
  field("network", fc.constantFrom("none", "proxy"), false, (x, y) => (x ?? "none") !== y),
  field("cwdConfigHashes", opt(cfgArb), true),
];

const recipientList = (min: number, max: number) =>
  fc.uniqueArray(emailArb, { minLength: min, maxLength: max });
const msgId = fc.stringMatching(/^<[a-z0-9]{1,8}@[a-z]{1,6}\.test>$/);
const headerArb = dict(fc.stringMatching(/^x-[a-z]{1,6}$/), fc.string({ maxLength: 10 }), 3);

const emailBase: fc.Arbitrary<Args> = fc.record({
  account: emailArb,
  to: recipientList(1, 3),
  cc: opt(recipientList(0, 2)),
  bcc: opt(recipientList(0, 2)),
  subject: fc.string({ maxLength: 20 }),
  bodySha256: shaArb,
  htmlSha256: opt(shaArb),
  mimeSha256: opt(shaArb),
  from: opt(emailArb),
  sender: opt(emailArb),
  replyTo: opt(recipientList(0, 2)),
  inReplyTo: opt(msgId),
  references: opt(fc.array(msgId, { maxLength: 3 })),
  headers: opt(headerArb),
  attachments: opt(fc.array(attachmentArb, { maxLength: 3 })),
});

const addRecipient =
  (list: "to" | "cc" | "bcc") =>
  (a: Args): fc.Arbitrary<Args> =>
    emailArb
      .filter((e) => !recipients(a).includes(e))
      .map((e) => ({ ...a, [list]: [...asList(a[list]), e] }));

const presentSetKey = (x: unknown) => (x === undefined ? "absent" : setKey(x));

const emailMutations: Mutation[] = [
  field("account", emailArb, true),
  { name: "to: add a new recipient", grant: true, mutate: addRecipient("to") },
  { name: "cc: add a new recipient", grant: true, mutate: addRecipient("cc") },
  { name: "bcc: add a new recipient", grant: true, mutate: addRecipient("bcc") },
  {
    name: "to: replace the list",
    grant: (a, b) => JSON.stringify(recipients(a)) !== JSON.stringify(recipients(b)),
    mutate: (a) =>
      recipientList(1, 3)
        .filter((v) => setKey(a.to) !== setKey(v))
        .map((v) => ({ ...a, to: v })),
  },
  {
    name: "move a to-recipient into cc",
    grant: false,
    mutate: (a) =>
      fc.constant({ ...a, to: asList(a.to).slice(1), cc: [...asList(a.cc), asList(a.to)[0]] }),
  },
  field("subject", fc.string({ maxLength: 20 }), false),
  field("bodySha256", shaArb, false),
  field("htmlSha256", opt(shaArb), false),
  field("mimeSha256", opt(shaArb), false),
  field("from", opt(emailArb), false),
  field("sender", opt(emailArb), false),
  field(
    "replyTo",
    opt(recipientList(0, 2)),
    false,
    (x, y) => presentSetKey(x) !== presentSetKey(y),
  ),
  field("inReplyTo", opt(msgId), false),
  field("references", opt(fc.array(msgId, { maxLength: 3 })), false),
  field("headers", opt(headerArb), false),
  field(
    "attachments",
    opt(fc.array(attachmentArb, { maxLength: 3 })),
    false,
    (x, y) => attKey(x) !== attKey(y),
  ),
];
const calendarBase: fc.Arbitrary<Args> = fc.record({
  account: emailArb,
  calendarId: ident,
  operation: fc.constantFrom("create", "update", "delete", "respond"),
  eventSha256: shaArb,
});
const calendarMutations: Mutation[] = [
  field("account", emailArb, true),
  field("calendarId", ident, true),
  field("operation", fc.constantFrom("create", "update", "delete", "respond"), true),
  field("eventSha256", shaArb, false),
];

const channelArb = fc.constantFrom("telegram", "imessage", "whatsapp", "slack", "signal");
const messageBase: fc.Arbitrary<Args> = fc.record({
  channel: channelArb,
  account: ident,
  recipient: fc.stringMatching(/^[+a-z0-9]{1,12}$/),
  bodySha256: shaArb,
  attachments: opt(fc.array(attachmentArb, { maxLength: 3 })),
});
const messageMutations: Mutation[] = [
  field("channel", channelArb, true),
  field("account", ident, true),
  field("recipient", fc.stringMatching(/^[+a-z0-9]{1,12}$/), true),
  field("bodySha256", shaArb, false),
  field(
    "attachments",
    opt(fc.array(attachmentArb, { maxLength: 3 })),
    false,
    (x, y) => attKey(x) !== attKey(y),
  ),
];

const methodArb = fc.constantFrom("get", "post", "dialog");
const formFieldName = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/);
const formFields = dict(formFieldName, fc.string({ maxLength: 10 }), 5);
const formBase: fc.Arbitrary<Args> = fc.record({
  pageUrl: urlArb,
  action: urlArb,
  method: methodArb,
  fields: formFields,
  submitRef: opt(fc.stringMatching(/^ref_[0-9]{1,3}$/)),
});
const withOrigin = (u: string, o: string) => `${o}${u.slice(originOf(u).length)}`;
const withPath = (u: string, p: string) => {
  const q = u.indexOf("?");
  return `${originOf(u)}${p}${q < 0 ? "" : u.slice(q)}`;
};
const formMutations: Mutation[] = [
  {
    name: "page origin",
    grant: true,
    mutate: (a) =>
      originArb
        .filter((o) => o !== originOf(a.pageUrl as string))
        .map((o) => ({ ...a, pageUrl: withOrigin(a.pageUrl as string, o) })),
  },
  {
    name: "page pathname",
    grant: true,
    mutate: (a) =>
      pathArb
        .filter((p) => p !== pathOf(a.pageUrl as string))
        .map((p) => ({ ...a, pageUrl: withPath(a.pageUrl as string, p) })),
  },
  field("action", urlArb, false, (x, y) => x !== y),
  {
    name: "formaction to another origin",
    grant: false,
    mutate: (a) =>
      originArb
        .filter((o) => o !== originOf(a.action as string))
        .map((o) => ({ ...a, action: withOrigin(a.action as string, o) })),
  },
  field("method", methodArb, false, (x, y) => x !== y),
  {
    name: "add a (hidden) field",
    grant: false,
    mutate: (a) => {
      const f = a.fields as Record<string, string>;
      return fc
        .tuple(
          formFieldName.filter((n) => !Object.hasOwn(f, n)),
          fc.string({ maxLength: 10 }),
        )
        .map(([n, v]) => ({ ...a, fields: { ...f, [n]: v } }));
    },
  },
  {
    name: "change one field value",
    grant: false,
    mutate: (a) => {
      const f = a.fields as Record<string, string>;
      const names = Object.keys(f);
      if (names.length === 0) {
        return fc.string({ maxLength: 10 }).map((v) => ({ ...a, fields: { hidden_csrf: v } }));
      }
      return fc
        .tuple(fc.constantFrom(...names), fc.string({ maxLength: 10 }))
        .filter(([n, v]) => f[n] !== v)
        .map(([n, v]) => ({ ...a, fields: { ...f, [n]: v } }));
    },
  },
  field("submitRef", opt(fc.stringMatching(/^ref_[0-9]{1,3}$/)), false),
];

const elementTypeArb = fc.constantFrom(
  "text",
  "password",
  "email",
  "tel",
  "textarea",
  "contenteditable",
  "select",
);
const fillBase: fc.Arbitrary<Args> = fc.record({
  itemId: ident,
  origin: urlArb,
  ref: fc.stringMatching(/^ref_[0-9]{1,3}$/),
  elementName: fc.string({ maxLength: 10 }),
  elementType: elementTypeArb,
  field: fc.constantFrom(...CREDENTIAL_FILL_FIELDS),
  tabId: opt(ident),
});
const fillMutations: Mutation[] = [
  field("itemId", ident, true),
  {
    name: "origin",
    grant: true,
    mutate: (a) =>
      originArb
        .filter((o) => o !== originOf(a.origin as string))
        .map((o) => ({ ...a, origin: withOrigin(a.origin as string, o) })),
  },
  field("ref", fc.stringMatching(/^ref_[0-9]{1,3}$/), false),
  field("elementName", fc.string({ maxLength: 10 }), false),
  field("elementType", elementTypeArb, false),
  field("field", fc.constantFrom(...CREDENTIAL_FILL_FIELDS), false),
  field("tabId", opt(ident), false),
];

const lineItemArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 10 }),
  qty: fc.integer({ min: 1, max: 20 }),
  unitPriceMinor: fc.nat({ max: 1_000_000 }),
});
const lineItemsArb = fc.array(lineItemArb, { minLength: 1, maxLength: 4 });
const lineItemsKey = (x: unknown) =>
  JSON.stringify(
    (x as { name: string; qty: number; unitPriceMinor: number }[])
      .map((li) => canonicalJSON(li))
      .sort(),
  );
const currencyArb = fc.stringMatching(/^[A-Z]{3}$/);
const purchaseBase: fc.Arbitrary<Args> = fc.record({
  merchant: hostArb,
  amountMinor: fc.integer({ min: 1, max: 10_000_000 }),
  currency: currencyArb,
  lineItems: lineItemsArb,
  paymentSourceId: ident,
});
// No reusable purchase grants: the grant key is the binding, so every change changes both.
const purchaseMutations: Mutation[] = [
  field("merchant", hostArb, true),
  field("amountMinor", fc.integer({ min: 1, max: 10_000_000 }), true),
  field("currency", currencyArb, true),
  field("lineItems", lineItemsArb, true, (x, y) => lineItemsKey(x) !== lineItemsKey(y)),
  field("paymentSourceId", ident, true),
];

const writeOps = fc.constantFrom("create", "overwrite", "edit", "append", "rename");
const fileBase: fc.Arbitrary<Args> = fc.record({
  realPath: absPath,
  operation: writeOps,
  contentSha256: shaArb,
  mode: opt(fc.integer({ min: 0, max: 0o7777 })),
  root: opt(absPath),
});
const fileMutations: Mutation[] = [
  // The grant root defaults to the real path when the engine did not supply one.
  field("realPath", absPath, (a) => a.root === undefined),
  field("operation", writeOps, true),
  field("contentSha256", shaArb, false),
  field("mode", opt(fc.integer({ min: 0, max: 0o7777 })), false),
  // The folder-grant root is grant-only: not in the binding hash (security §3.5).
  {
    name: "root (grant-only)",
    hash: false,
    grant: true,
    mutate: (a) =>
      absPath.filter((r) => r !== (a.root ?? a.realPath)).map((r) => ({ ...a, root: r })),
  },
];

const mcpBase: fc.Arbitrary<Args> = fc.record({
  serverId: ident,
  tool: ident,
  toolsListHash: shaArb,
  argsSha256: shaArb,
});
const mcpMutations: Mutation[] = [
  field("serverId", ident, true),
  field("tool", ident, true),
  field("toolsListHash", shaArb, true),
  field("argsSha256", shaArb, false),
];

const tierArb = fc.constantFrom("read", "click", "interact");
const appArb = fc.stringMatching(/^com\.[a-z]{1,8}\.[a-z]{1,8}$/);
const computerBase: fc.Arbitrary<Args> = fc.record({
  app: appArb,
  tierRequired: tierArb,
  action: fc.string({ minLength: 1, maxLength: 12 }),
  elementRefSha256: opt(shaArb),
});
const computerMutations: Mutation[] = [
  field("app", appArb, true),
  field("tierRequired", tierArb, true),
  field("action", fc.string({ minLength: 1, maxLength: 12 }), false),
  field("elementRefSha256", opt(shaArb), false),
];

const newOriginBase: fc.Arbitrary<Args> = fc.record({
  url: urlArb,
  taskId: fc.option(ident, { nil: null }),
});
const newOriginMutations: Mutation[] = [
  {
    name: "origin",
    grant: true,
    mutate: (a) =>
      originArb
        .filter((o) => o !== originOf(a.url as string))
        .map((o) => ({ ...a, url: withOrigin(a.url as string, o) })),
  },
  field("taskId", fc.option(ident, { nil: null }), false, (x, y) => (x ?? null) !== (y ?? null)),
];

const COVERED: Record<string, [fc.Arbitrary<Args>, Mutation[]]> = {
  exec: [execBase(false), execMutations(false)],
  exec_host: [execBase(true), execMutations(true)],
  send_email: [emailBase, emailMutations],
  calendar_write: [calendarBase, calendarMutations],
  message_send: [messageBase, messageMutations],
  browser_submit: [formBase, formMutations],
  credential_fill: [fillBase, fillMutations],
  purchase: [purchaseBase, purchaseMutations],
  file_write: [fileBase, fileMutations],
  mcp_tool: [mcpBase, mcpMutations],
  computer_action: [computerBase, computerMutations],
  new_origin: [newOriginBase, newOriginMutations],
};

// ---- 1. every bound field is bound ------------------------------------------------------------

describe("bindingFor: every bound field changes the hash (property)", () => {
  it("covers every kind with a dedicated builder", () => {
    expect(Object.keys(COVERED).sort()).toEqual([...DEDICATED_BINDING_KINDS].sort());
  });
  for (const kind of DEDICATED_BINDING_KINDS) {
    const entry = COVERED[kind];
    if (entry === undefined) continue;
    describe(kind, () => describeMutations(kind, entry[0], entry[1]));
  }
});

describe("bindingFor: unbound details do not change the binding (property)", () => {
  it("new_origin binds the origin only: path and query changes are the same origin", () => {
    fc.assert(
      fc.property(newOriginBase, pathArb, queryArb, (a, p, q) => {
        const b = { ...a, url: `${originOf(a.url as string)}${p}${q}` };
        expect(bindingFor("new_origin", b).bindingHash).toBe(
          bindingFor("new_origin", a).bindingHash,
        );
      }),
      RUNS,
    );
  });

  it("credential_fill origin ignores the path; element type is case-insensitive", () => {
    fc.assert(
      fc.property(fillBase, pathArb, (a, p) => {
        const b = {
          ...a,
          origin: withPath(a.origin as string, p),
          elementType: (a.elementType as string).toUpperCase(),
        };
        const x = bindingFor("credential_fill", a);
        const y = bindingFor("credential_fill", b);
        expect(y.bindingHash).toBe(x.bindingHash);
        expect(y.grantKey).toBe(x.grantKey);
      }),
      RUNS,
    );
  });

  it("browser_submit: method is case-insensitive and the action fragment is dropped", () => {
    fc.assert(
      fc.property(formBase, (a) => {
        const b = {
          ...a,
          method: (a.method as string).toUpperCase(),
          action: `${a.action as string}#frag`,
        };
        expect(bindingFor("browser_submit", b).bindingHash).toBe(
          bindingFor("browser_submit", a).bindingHash,
        );
      }),
      RUNS,
    );
  });

  it("exec: absent env, network and cwdConfigHashes defaults equal their explicit forms", () => {
    const a = { argv: ["ls"], cwd: "/w", executable: "/bin/ls" };
    const x = bindingFor("exec", a);
    const y = bindingFor("exec", { ...a, env: {}, network: "none" });
    expect(y.bindingHash).toBe(x.bindingHash);
    expect(y.grantKey).toBe(x.grantKey);
  });
});

// ---- 2. sorted vs order-sensitive -------------------------------------------------------------

const shuffled = <T>(xs: T[]): fc.Arbitrary<T[]> =>
  fc.shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length });

describe("order: sorted where the spec sorts, exact where it must not (property)", () => {
  it("email recipients: order, case and duplicates do not matter", () => {
    fc.assert(
      fc.property(
        emailBase.chain((a) =>
          fc.tuple(
            fc.constant(a),
            shuffled(asList(a.to)),
            fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
            fc.boolean(),
          ),
        ),
        ([a, to, upper, dup]) => {
          const cased = to.map((e, i) => (upper[i % 3] === true ? e.toUpperCase() : e));
          const b = { ...a, to: dup ? [...cased, ...to] : cased };
          const x = bindingFor("send_email", a);
          const y = bindingFor("send_email", b);
          expect(y.bindingHash).toBe(x.bindingHash);
          expect(y.grantKey).toBe(x.grantKey);
        },
      ),
      RUNS,
    );
  });

  it("email cc / bcc / replyTo order does not matter", () => {
    fc.assert(
      fc.property(
        emailBase.chain((a) =>
          fc.tuple(
            fc.constant(a),
            shuffled(asList(a.cc)),
            shuffled(asList(a.bcc)),
            shuffled(asList(a.replyTo)),
          ),
        ),
        ([a, cc, bcc, replyTo]) => {
          const b = {
            ...a,
            cc: a.cc === undefined ? undefined : cc,
            bcc: a.bcc === undefined ? undefined : bcc,
            replyTo: a.replyTo === undefined ? undefined : replyTo,
          };
          expect(bindingFor("send_email", b).bindingHash).toBe(
            bindingFor("send_email", a).bindingHash,
          );
        },
      ),
      RUNS,
    );
  });

  it("email and message attachments: order does not matter", () => {
    fc.assert(
      fc.property(
        fc
          .array(attachmentArb, { minLength: 1, maxLength: 4 })
          .chain((xs) => fc.tuple(fc.constant(xs), shuffled(xs))),
        emailBase,
        messageBase,
        ([xs, ys], e, m) => {
          expect(bindingFor("send_email", { ...e, attachments: ys }).bindingHash).toBe(
            bindingFor("send_email", { ...e, attachments: xs }).bindingHash,
          );
          expect(bindingFor("message_send", { ...m, attachments: ys }).bindingHash).toBe(
            bindingFor("message_send", { ...m, attachments: xs }).bindingHash,
          );
        },
      ),
      RUNS,
    );
  });

  it("email headers: insertion order and name case do not matter", () => {
    fc.assert(
      fc.property(emailBase, headerArb, (a, h) => {
        const reversed = Object.fromEntries(
          Object.entries(h)
            .reverse()
            .map(([k, v]) => [k.toUpperCase(), v]),
        );
        expect(bindingFor("send_email", { ...a, headers: reversed }).bindingHash).toBe(
          bindingFor("send_email", { ...a, headers: h }).bindingHash,
        );
      }),
      RUNS,
    );
  });

  it("exec env and cwdConfigHashes: key order does not matter", () => {
    fc.assert(
      fc.property(execBase(false), envArb, cfgArb, (a, env, cfg) => {
        const rev = <T>(o: Record<string, T>) => Object.fromEntries(Object.entries(o).reverse());
        const x = bindingFor("exec", { ...a, env, cwdConfigHashes: cfg });
        const y = bindingFor("exec", { ...a, env: rev(env), cwdConfigHashes: rev(cfg) });
        expect(y.bindingHash).toBe(x.bindingHash);
        expect(y.grantKey).toBe(x.grantKey);
      }),
      RUNS,
    );
  });

  it("browser_submit: form field order does not matter", () => {
    fc.assert(
      fc.property(formBase, (a) => {
        const f = a.fields as Record<string, string>;
        const b = { ...a, fields: Object.fromEntries(Object.entries(f).reverse()) };
        expect(bindingFor("browser_submit", b).bindingHash).toBe(
          bindingFor("browser_submit", a).bindingHash,
        );
      }),
      RUNS,
    );
  });

  it("purchase: line item order does not matter", () => {
    fc.assert(
      fc.property(
        purchaseBase.chain((a) => fc.tuple(fc.constant(a), shuffled(a.lineItems as unknown[]))),
        ([a, items]) => {
          expect(bindingFor("purchase", { ...a, lineItems: items }).bindingHash).toBe(
            bindingFor("purchase", a).bindingHash,
          );
        },
      ),
      RUNS,
    );
  });

  it("purchase: a duplicated line item is not collapsed", () => {
    fc.assert(
      fc.property(purchaseBase, (a) => {
        const items = a.lineItems as unknown[];
        const b = { ...a, lineItems: [...items, items[0]] };
        expect(bindingFor("purchase", b).bindingHash).not.toBe(
          bindingFor("purchase", a).bindingHash,
        );
      }),
      RUNS,
    );
  });

  it("exec argv: order matters (never sorted)", () => {
    fc.assert(
      fc.property(
        execBase(false),
        fc.uniqueArray(argStr, { minLength: 2, maxLength: 5 }),
        (a, argv) => {
          const x = bindingFor("exec", { ...a, argv });
          const y = bindingFor("exec", { ...a, argv: [...argv].reverse() });
          expect(y.bindingHash).not.toBe(x.bindingHash);
          expect(y.grantKey).not.toBe(x.grantKey);
        },
      ),
      RUNS,
    );
  });

  it("exec argv: example swap", () => {
    const a = { argv: ["rm", "-r", "build"], cwd: "/w", executable: "/bin/rm" };
    const b = { ...a, argv: ["rm", "build", "-r"] };
    expect(bindingFor("exec", a).bindingHash).not.toBe(bindingFor("exec", b).bindingHash);
  });

  it("email references: order matters", () => {
    const a = {
      account: "me@example.org",
      to: ["a@example.org"],
      subject: "s",
      bodySha256: SHA_A,
      references: ["<1@x.test>", "<2@x.test>"],
    };
    const b = { ...a, references: ["<2@x.test>", "<1@x.test>"] };
    expect(bindingFor("send_email", a).bindingHash).not.toBe(
      bindingFor("send_email", b).bindingHash,
    );
  });
});

// ---- 3. S23 design-13: strict canonical JSON --------------------------------------------------

const EXEC = { argv: ["ls"], cwd: "/workspace", executable: "/bin/ls" };
const PURCHASE = {
  merchant: "shop.example",
  amountMinor: 1999,
  currency: "USD",
  lineItems: [{ name: "widget", qty: 1, unitPriceMinor: 1999 }],
  paymentSourceId: "pm_1",
};
const EMAIL = {
  account: "me@example.org",
  to: ["mom@gmail.com"],
  subject: "Dinner",
  bodySha256: SHA_A,
};
const FORM = {
  pageUrl: "https://shop.example/checkout",
  action: "https://shop.example/checkout/submit",
  method: "post",
  fields: { email: "me@example.org", csrf: "t1" },
};

describe("design-13: strict canonical JSON inside bindings", () => {
  it("NFC and NFD argv strings hash differently (no Unicode folding)", () => {
    const nfc = "café.txt";
    const nfd = "café.txt";
    expect(nfc.normalize("NFC")).toBe(nfd.normalize("NFC"));
    const x = bindingFor("exec", { ...EXEC, argv: ["cat", nfc] });
    const y = bindingFor("exec", { ...EXEC, argv: ["cat", nfd] });
    expect(y.bindingHash).not.toBe(x.bindingHash);
    expect(y.grantKey).not.toBe(x.grantKey);
  });

  it("NFC and NFD paths hash differently (exec cwd, file_write realPath)", () => {
    const nfc = "/w/café";
    const nfd = "/w/café";
    expect(bindingFor("exec", { ...EXEC, cwd: nfc }).bindingHash).not.toBe(
      bindingFor("exec", { ...EXEC, cwd: nfd }).bindingHash,
    );
    const fw = { operation: "create", contentSha256: SHA_A };
    expect(bindingFor("file_write", { ...fw, realPath: nfc }).bindingHash).not.toBe(
      bindingFor("file_write", { ...fw, realPath: nfd }).bindingHash,
    );
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["-0", -0],
    ["a number", 1],
    ["null", null],
    ["a Map", new Map([["a", "b"]])],
    ["a Date", new Date(0)],
    ["an array with undefined", ["a", undefined]],
  ])("exec env value that is %s throws", (_label, value) => {
    expectCanonicalReject(() => bindingFor("exec", { ...EXEC, env: { FOO: value } }));
  });

  it.each([
    ["undefined", ["ls", undefined]],
    // biome-ignore lint/suspicious/noSparseArray: a hole is exactly the input under test
    ["a hole", ["ls", , "-l"]],
    ["NaN", ["ls", Number.NaN]],
    ["a Date", ["ls", new Date(0)]],
    ["a lone surrogate", ["ls", "\uD800"]],
  ])("exec argv containing %s throws", (_label, argv) => {
    expectCanonicalReject(() => bindingFor("exec", { ...EXEC, argv }));
  });

  it.each([
    ["19.99", 19.99],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-0", -0],
    ["0", 0],
    ["-1", -1],
    ["2^53 (not a safe integer)", 2 ** 53],
    ["a string", "1999"],
    ["a Date", new Date(0)],
  ])("purchase amountMinor %s throws", (_label, amountMinor) => {
    expectCanonicalReject(() => bindingFor("purchase", { ...PURCHASE, amountMinor }));
  });

  it("purchase amountMinor accepts the largest safe integer", () => {
    expect(() =>
      bindingFor("purchase", { ...PURCHASE, amountMinor: Number.MAX_SAFE_INTEGER }),
    ).not.toThrow();
  });

  it.each([
    ["qty 0", { name: "w", qty: 0, unitPriceMinor: 1 }],
    ["qty 1.5", { name: "w", qty: 1.5, unitPriceMinor: 1 }],
    ["qty NaN", { name: "w", qty: Number.NaN, unitPriceMinor: 1 }],
    ["unitPriceMinor -0", { name: "w", qty: 1, unitPriceMinor: -0 }],
    ["unitPriceMinor 0.5", { name: "w", qty: 1, unitPriceMinor: 0.5 }],
    ["unitPriceMinor Infinity", { name: "w", qty: 1, unitPriceMinor: Number.POSITIVE_INFINITY }],
    ["an undefined item", undefined],
    ["a Map item", new Map([["name", "w"]])],
  ])("purchase line item with %s throws", (_label, item) => {
    expectCanonicalReject(() => bindingFor("purchase", { ...PURCHASE, lineItems: [item] }));
  });

  it.each([
    ["size NaN", { sha256: SHA_B, size: Number.NaN, name: "a.pdf" }],
    ["size -0", { sha256: SHA_B, size: -0, name: "a.pdf" }],
    ["size 1.5", { sha256: SHA_B, size: 1.5, name: "a.pdf" }],
    ["an undefined attachment", undefined],
  ])("email attachment with %s throws", (_label, att) => {
    expectCanonicalReject(() => bindingFor("send_email", { ...EMAIL, attachments: [att] }));
  });

  it.each([
    ["NaN", Number.NaN],
    ["-0", -0],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("file_write mode %s throws", (_label, mode) => {
    expectCanonicalReject(() =>
      bindingFor("file_write", {
        realPath: "/w/a",
        operation: "create",
        contentSha256: SHA_A,
        mode,
      }),
    );
  });

  it("email recipient list with undefined throws", () => {
    expectCanonicalReject(() =>
      bindingFor("send_email", { ...EMAIL, to: ["mom@gmail.com", undefined] }),
    );
  });

  it("form field value that is not a string throws", () => {
    for (const v of [Number.NaN, -0, new Date(0), new Map(), undefined, null]) {
      expectCanonicalReject(() =>
        bindingFor("browser_submit", { ...FORM, fields: { ...FORM.fields, x: v } }),
      );
    }
  });

  it("email header value that is not a string throws", () => {
    for (const v of [Number.NaN, new Date(0), new Map(), null]) {
      expectCanonicalReject(() => bindingFor("send_email", { ...EMAIL, headers: { "x-a": v } }));
    }
  });

  it("args that are not a plain object throw", () => {
    for (const args of [null, undefined, "x", 1, ["ls"]]) {
      expectCanonicalReject(() => bindingFor("exec", args));
    }
  });

  it("bindingHash itself rejects non-canonical values", () => {
    for (const v of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      new Map(),
      new Date(0),
      [undefined],
    ]) {
      expectCanonicalReject(() => bindingHash("exec", { v }));
    }
  });

  // Was a bug, fixed (src/binding.ts `obj`): a Map, Date or other class instance passed where a builder expects
  // a record is accepted, and `Object.entries` of it is empty, so the binding silently covers no
  // env / form fields / headers / config hashes at all. These document the expected behaviour and
  // are marked `fails` until `obj` rejects non-plain objects.
  it("exec env given as a Map throws instead of binding an empty env", () => {
    expectCanonicalReject(() =>
      bindingFor("exec", { ...EXEC, env: new Map([["LD_PRELOAD", "/tmp/x.so"]]) }),
    );
  });
  it("exec env given as a Date throws", () => {
    expectCanonicalReject(() => bindingFor("exec", { ...EXEC, env: new Date(0) }));
  });
  it("exec cwdConfigHashes given as a Map throws", () => {
    expectCanonicalReject(() =>
      bindingFor("exec", { ...EXEC, cwdConfigHashes: new Map([[".git/config", SHA_A]]) }),
    );
  });
  it("browser_submit fields given as a Map throws", () => {
    expectCanonicalReject(() =>
      bindingFor("browser_submit", { ...FORM, fields: new Map([["csrf", "t1"]]) }),
    );
  });
  it("send_email headers given as a Map throws", () => {
    expectCanonicalReject(() =>
      bindingFor("send_email", { ...EMAIL, headers: new Map([["Bcc", "x@evil.test"]]) }),
    );
  });

  /** Either the builder refuses the input, or the two inputs bind differently. */
  function rejectsOrDiffers(kind: ApprovalKind, a: unknown, b: unknown): boolean {
    try {
      return bindingFor(kind, a).bindingHash !== bindingFor(kind, b).bindingHash;
    } catch (e) {
      return e instanceof PsycheError && e.code === "invalid_params";
    }
  }

  // Was a bug, fixed (src/binding.ts formBinding / emailBinding / execBinding): values are copied into a fresh
  // `{}` with `out[name] = v`; for the own key "__proto__" (e.g. from JSON.parse of a page's form)
  // that assignment is a no-op, so the value is not hashed and can change without changing the
  // binding (the field name is still listed in fieldNames).
  it("a form field named __proto__ has its value bound", () => {
    const a = { ...FORM, fields: JSON.parse('{"csrf":"t1","__proto__":"a"}') };
    const b = { ...FORM, fields: JSON.parse('{"csrf":"t1","__proto__":"b"}') };
    expect(rejectsOrDiffers("browser_submit", a, b)).toBe(true);
  });
  it("an email header named __proto__ is bound", () => {
    const a = { ...EMAIL, headers: JSON.parse('{"__proto__":"a"}') };
    const b = { ...EMAIL, headers: JSON.parse('{"__proto__":"b"}') };
    expect(rejectsOrDiffers("send_email", a, b)).toBe(true);
  });

  // Was a bug, fixed (src/binding.ts emailBinding): header names are lowercased into one object, so two
  // headers differing only in case collapse and the first value is silently unbound.
  it("headers differing only in case are both bound (or rejected)", () => {
    const a = { ...EMAIL, headers: { "X-Mailer": "a", "x-mailer": "z" } };
    const b = { ...EMAIL, headers: { "X-Mailer": "b", "x-mailer": "z" } };
    expect(rejectsOrDiffers("send_email", a, b)).toBe(true);
  });
});

// ---- 4. design-11: email --------------------------------------------------------------------

describe("design-11: email binding and grant key", () => {
  it("grant key is the exact sorted recipient set, never the domain", () => {
    const mom = bindingFor("send_email", EMAIL);
    const attacker = bindingFor("send_email", { ...EMAIL, to: ["attacker@gmail.com"] });
    expect(attacker.grantKey).not.toBe(mom.grantKey);
    expect(mom.grantFields).toEqual({ account: "me@example.org", recipients: ["mom@gmail.com"] });
    const plus = bindingFor("send_email", { ...EMAIL, cc: ["attacker@gmail.com"] });
    expect(plus.grantKey).not.toBe(mom.grantKey);
    expect(plus.grantFields.recipients).toEqual(["attacker@gmail.com", "mom@gmail.com"]);
  });

  it("body change keeps the grant key; recipient set change does not", () => {
    const a = bindingFor("send_email", EMAIL);
    const body = bindingFor("send_email", { ...EMAIL, bodySha256: SHA_B });
    expect(body.bindingHash).not.toBe(a.bindingHash);
    expect(body.grantKey).toBe(a.grantKey);
  });

  it.each([
    ["replyTo", { replyTo: ["attacker@evil.test"] }],
    ["from", { from: "other@example.org" }],
    ["sender", { sender: "other@example.org" }],
    ["inReplyTo", { inReplyTo: "<id@evil.test>" }],
    ["references", { references: ["<id@evil.test>"] }],
    ["headers", { headers: { "List-Unsubscribe": "<mailto:x@evil.test>" } }],
    ["htmlSha256", { htmlSha256: SHA_B }],
    ["mimeSha256", { mimeSha256: SHA_C }],
    ["attachments", { attachments: [{ sha256: SHA_B, size: 10, name: "a.pdf" }] }],
    ["subject", { subject: "Dinner?" }],
  ])("%s changes the binding hash but not the grant key", (_label, extra) => {
    const a = bindingFor("send_email", EMAIL);
    const b = bindingFor("send_email", { ...EMAIL, ...extra });
    expect(b.bindingHash).not.toBe(a.bindingHash);
    expect(b.grantKey).toBe(a.grantKey);
  });

  it("a display name never stands in for the address", () => {
    expect(canonicalEmail('"alice@example.org" <attacker@evil.test>').address).toBe(
      "attacker@evil.test",
    );
    const shown = bindingFor("send_email", {
      ...EMAIL,
      to: ['"alice@example.org" <attacker@evil.test>'],
    });
    expect(shown.fields.to).toEqual(["attacker@evil.test"]);
    expect(shown.grantKey).toBe(
      bindingFor("send_email", { ...EMAIL, to: ["attacker@evil.test"] }).grantKey,
    );
    expect(shown.grantKey).not.toBe(
      bindingFor("send_email", { ...EMAIL, to: ["alice@example.org"] }).grantKey,
    );
  });

  it("an IDN domain becomes punycode", () => {
    const c = canonicalEmail("User@Bücher.Example");
    expect(c.address).toBe("user@xn--bcher-kva.example");
    expect(c.idn).toBe(true);
    expect(canonicalEmail("a@example.org").idn).toBe(false);
    const uni = bindingFor("send_email", { ...EMAIL, to: ["user@bücher.example"] });
    const puny = bindingFor("send_email", { ...EMAIL, to: ["user@xn--bcher-kva.example"] });
    expect(uni.fields.to).toEqual(["user@xn--bcher-kva.example"]);
    expect(uni.bindingHash).toBe(puny.bindingHash);
  });

  it("a non-ASCII local part throws", () => {
    expectInvalid(() => canonicalEmail("jörg@example.org"));
    // Cyrillic а (U+0430) homograph of "alice".
    expectInvalid(() => canonicalEmail("аlice@example.org"));
    expectInvalid(() => bindingFor("send_email", { ...EMAIL, to: ["аlice@example.org"] }));
  });

  it("malformed addresses throw", () => {
    for (const bad of [
      "",
      "mom",
      "@gmail.com",
      "mom@",
      "mom@localhost",
      "a b@x.org",
      "a@x.org, b@y.org",
      "a@x.org (b@y.org)",
    ]) {
      expectInvalid(() => canonicalEmail(bad));
    }
  });

  it("no recipients throws", () => {
    expectInvalid(() => bindingFor("send_email", { ...EMAIL, to: [] }));
  });

  it("recipient case and duplicates collapse", () => {
    const a = bindingFor("send_email", { ...EMAIL, to: ["Mom@Gmail.COM", "mom@gmail.com"] });
    expect(a.fields.to).toEqual(["mom@gmail.com"]);
    expect(a.bindingHash).toBe(bindingFor("send_email", EMAIL).bindingHash);
  });
});

// ---- 5. design-10: browser form submit ------------------------------------------------------

describe("design-10: browser_submit binds action, actionOrigin, method and every field", () => {
  const base = bindingFor("browser_submit", FORM);

  it("binds the resolved action URL and its origin", () => {
    expect(base.fields.action).toBe("https://shop.example/checkout/submit");
    expect(base.fields.actionOrigin).toBe("https://shop.example");
    expect(base.fields.method).toBe("post");
    expect(base.fields.fieldNames).toEqual(["csrf", "email"]);
    expect(base.grantFields).toEqual({ origin: "https://shop.example", pathname: "/checkout" });
  });

  it("formaction to another origin changes the hash (same page, same grant key)", () => {
    const b = bindingFor("browser_submit", { ...FORM, action: "https://evil.test/collect" });
    expect(b.bindingHash).not.toBe(base.bindingHash);
    expect(b.fields.actionOrigin).toBe("https://evil.test");
    expect(b.grantKey).toBe(base.grantKey);
  });

  it("action path or query change changes the hash", () => {
    for (const action of [
      "https://shop.example/checkout/other",
      "https://shop.example/checkout/submit?to=evil",
      "http://shop.example/checkout/submit",
      "https://shop.example:8443/checkout/submit",
    ]) {
      expect(bindingFor("browser_submit", { ...FORM, action }).bindingHash).not.toBe(
        base.bindingHash,
      );
    }
  });

  it("method change changes the hash", () => {
    expect(bindingFor("browser_submit", { ...FORM, method: "get" }).bindingHash).not.toBe(
      base.bindingHash,
    );
  });

  it("hidden field value change, added hidden field, or emptied value changes the hash", () => {
    for (const fields of [
      { ...FORM.fields, csrf: "t2" },
      { ...FORM.fields, redirect: "https://evil.test" },
      { ...FORM.fields, csrf: "" },
      { email: "me@example.org" },
    ]) {
      expect(bindingFor("browser_submit", { ...FORM, fields }).bindingHash).not.toBe(
        base.bindingHash,
      );
    }
  });

  it("an opaque or userinfo action URL throws", () => {
    for (const action of [
      "javascript:alert(1)",
      "data:text/html,x",
      "https://shop.example@evil.test/",
    ]) {
      expectInvalid(() => bindingFor("browser_submit", { ...FORM, action }));
    }
  });

  it("an unknown method throws", () => {
    expectInvalid(() => bindingFor("browser_submit", { ...FORM, method: "put" }));
  });
});

// ---- 6. design-14: exec ---------------------------------------------------------------------

describe("design-14: exec stdin, cwd config and host binaries", () => {
  const a = bindingFor("exec", {
    ...EXEC,
    stdinSha256: SHA_A,
    cwdConfigHashes: { ".git/config": SHA_A },
  });

  it("stdinSha256 change changes the hash (grant key unchanged)", () => {
    const b = bindingFor("exec", {
      ...EXEC,
      stdinSha256: SHA_B,
      cwdConfigHashes: { ".git/config": SHA_A },
    });
    expect(b.bindingHash).not.toBe(a.bindingHash);
    expect(b.grantKey).toBe(a.grantKey);
  });

  it("cwdConfigHashes change changes the hash and the grant key", () => {
    for (const cwdConfigHashes of [
      { ".git/config": SHA_B },
      { ".git/config": SHA_A, Makefile: SHA_B },
      {},
      undefined,
    ]) {
      const b = bindingFor("exec", { ...EXEC, stdinSha256: SHA_A, cwdConfigHashes });
      expect(b.bindingHash).not.toBe(a.bindingHash);
      expect(b.grantKey).not.toBe(a.grantKey);
    }
  });

  it("env change changes the grant key (exec binds the same four fields)", () => {
    const x = bindingFor("exec", { ...EXEC, env: { FOO: "1" } });
    const y = bindingFor("exec", { ...EXEC, env: { FOO: "2" } });
    expect(y.grantKey).not.toBe(x.grantKey);
  });

  it("exec_host without executableSha256 throws", () => {
    expectCanonicalReject(() => bindingFor("exec_host", EXEC));
  });

  it("exec_host binds the binary hash", () => {
    const x = bindingFor("exec_host", { ...EXEC, executableSha256: SHA_A });
    const y = bindingFor("exec_host", { ...EXEC, executableSha256: SHA_B });
    expect(y.bindingHash).not.toBe(x.bindingHash);
    expect(y.grantKey).not.toBe(x.grantKey);
  });

  it("malformed hashes, empty argv, NUL in argv, relative paths and bad network throw", () => {
    for (const args of [
      { ...EXEC, executableSha256: "sha256:ABC" },
      { ...EXEC, stdinSha256: "a".repeat(64) },
      { ...EXEC, cwdConfigHashes: { ".git/config": "nope" } },
      { ...EXEC, argv: [] },
      { ...EXEC, argv: ["ls", "a\0b"] },
      { ...EXEC, cwd: "workspace" },
      { ...EXEC, executable: "ls" },
      { ...EXEC, network: "host" },
    ]) {
      expectInvalid(() => bindingFor("exec", args));
    }
  });
});

// ---- other builders: validation examples ------------------------------------------------------

describe("builder validation and generic bindings", () => {
  it("file_write: delete binds a null content hash; other operations require one", () => {
    const d = bindingFor("file_write", {
      realPath: "/w/a",
      operation: "delete",
      contentSha256: null,
    });
    expect(d.fields).toEqual({ realPath: "/w/a", operation: "delete", contentSha256: null });
    expect(d.grantFields).toEqual({ root: "/w/a", operation: "delete" });
    expectInvalid(() =>
      bindingFor("file_write", { realPath: "/w/a", operation: "create", contentSha256: null }),
    );
    expectInvalid(() =>
      bindingFor("file_write", { realPath: "/w/a", operation: "chmod", contentSha256: SHA_A }),
    );
  });

  it("file_write: paths are lexically normalized before binding", () => {
    const x = bindingFor("file_write", {
      realPath: "/w/./b/../a/",
      operation: "create",
      contentSha256: SHA_A,
    });
    expect(x.fields.realPath).toBe("/w/a");
  });

  it("purchase: merchant URL and bare host canonicalize to the same host", () => {
    const a = bindingFor("purchase", PURCHASE);
    const b = bindingFor("purchase", { ...PURCHASE, merchant: "HTTPS://Shop.Example./cart" });
    expect(b.fields.merchant).toBe("shop.example");
    expect(b.bindingHash).toBe(a.bindingHash);
    expect(a.grantKey).toBe(grantKeyHash("purchase", a.fields));
  });

  it("purchase: currency must be ISO 4217 upper case", () => {
    for (const currency of ["usd", "US", "USDT", ""]) {
      expectInvalid(() => bindingFor("purchase", { ...PURCHASE, currency }));
    }
  });

  it("calendar, credential_fill and computer_action reject unknown enums", () => {
    expectInvalid(() =>
      bindingFor("calendar_write", {
        account: "a",
        calendarId: "c",
        operation: "move",
        eventSha256: SHA_A,
      }),
    );
    expectInvalid(() =>
      bindingFor("credential_fill", {
        itemId: "i",
        origin: "https://a.example",
        ref: "ref_1",
        elementName: "",
        elementType: "password",
        field: "ssn",
      }),
    );
    expectInvalid(() =>
      bindingFor("computer_action", { app: "com.a.b", tierRequired: "admin", action: "x" }),
    );
  });

  it("connector_action uses the MCP table with serverId, the generic table without", () => {
    const mcp = { serverId: "s", tool: "t", toolsListHash: SHA_A, argsSha256: SHA_B };
    expect(bindingFor("connector_action", mcp).fields).toEqual(mcp);
    const generic = bindingFor("connector_action", { tool: "t", paramsHash: SHA_A, target: "x" });
    expect(generic.fields).toEqual({ tool: "t", paramsHash: SHA_A, target: "x" });
    expect(generic.grantFields).toEqual({ tool: "t", target: "x" });
  });

  it("genericBindingFor binds tool, paramsHash and target; grant key ignores paramsHash", () => {
    const a = genericBindingFor("skill_install", { tool: "skills.install", paramsHash: SHA_A });
    const b = genericBindingFor("skill_install", { tool: "skills.install", paramsHash: SHA_B });
    const c = genericBindingFor("skill_install", {
      tool: "skills.install",
      paramsHash: SHA_A,
      target: "x",
    });
    expect(b.bindingHash).not.toBe(a.bindingHash);
    expect(b.grantKey).toBe(a.grantKey);
    expect(c.bindingHash).not.toBe(a.bindingHash);
    expect(c.grantKey).not.toBe(a.grantKey);
    expect(bindingFor("skill_install", { tool: "skills.install", paramsHash: SHA_A })).toEqual(a);
  });

  it("the kind is part of the hash", () => {
    const fields = { tool: "t", paramsHash: SHA_A };
    expect(bindingHash("plan_exit", fields)).not.toBe(bindingHash("skill_install", fields));
    expect(bindingFor("exec", EXEC).bindingHash).not.toBe(
      bindingFor("exec_host", { ...EXEC, executableSha256: SHA_A }).bindingHash,
    );
  });
});

// ---- 7. canonical targets -------------------------------------------------------------------

describe("canonical targets", () => {
  it("rejects userinfo (CVE-2025-47241 shape)", () => {
    expectInvalid(() => canonicalUrl("http://localhost.evil.test@127.0.0.1:3000"));
    expectInvalid(() => canonicalUrl("https://u:x@example.com/"));
  });

  it.each([
    "android://com.bank.app",
    "foo://x",
    "file:///etc/hosts",
    "javascript:alert(1)",
    "data:text/html,hi",
    "about:blank",
    "blob:https://example.com/uuid",
    "ws://example.com/",
    "chrome-extension://abc/page.html",
  ])("rejects the opaque or non-web scheme %s", (u) => {
    expectInvalid(() => canonicalUrl(u));
  });

  it("rejects strings that are not URLs", () => {
    for (const u of ["", "example.com", "/relative", "https://"])
      expectInvalid(() => canonicalUrl(u));
  });

  it("strips default ports and keeps others", () => {
    expect(canonicalUrl("https://example.com:443/a").origin).toBe("https://example.com");
    expect(canonicalUrl("https://example.com:443/a").port).toBeNull();
    expect(canonicalUrl("http://example.com:80/").origin).toBe("http://example.com");
    expect(canonicalUrl("http://example.com:443/").origin).toBe("http://example.com:443");
    expect(canonicalUrl("https://example.com:80/").port).toBe(80);
  });

  it("strips the trailing dot", () => {
    const u = canonicalUrl("http://localhost.:3000");
    expect(u.host).toBe("localhost");
    expect(u.origin).toBe("http://localhost:3000");
    expect(canonicalOrigin("https://example.com./x")).toBe("https://example.com");
  });

  it("lowercases scheme and host, keeps the path, drops the fragment", () => {
    const u = canonicalUrl("HTTPS://WWW.Example.COM/Path/A?Q=1#frag");
    expect(u.scheme).toBe("https");
    expect(u.host).toBe("www.example.com");
    expect(u.origin).toBe("https://www.example.com");
    expect(u.pathname).toBe("/Path/A");
    expect(u.href).toBe("https://www.example.com/Path/A?Q=1");
  });

  it("converts IDNA hosts to punycode (Cyrillic а in kayak)", () => {
    const spoof = canonicalUrl("https://www.kаyak.com");
    expect(spoof.host).toMatch(/(^|\.)xn--/);
    expect(spoof.origin).not.toBe(canonicalOrigin("https://www.kayak.com"));
    expect(isDangerousLookalike(spoof.host)).toBe(true);
    expect(isDangerousLookalike("www.kayak.com")).toBe(false);
    expect(canonicalUrl("https://Bücher.example/").host).toBe("xn--bcher-kva.example");
  });

  it("keeps IP literals", () => {
    expect(canonicalOrigin("http://127.0.0.1:3000/x")).toBe("http://127.0.0.1:3000");
    expect(canonicalOrigin("http://[::1]:8080/")).toBe("http://[::1]:8080");
  });

  it("canonical URLs are idempotent (property)", () => {
    fc.assert(
      fc.property(urlArb, (u) => {
        const c = canonicalUrl(u);
        expect(c.href).toBe(u);
        expect(canonicalUrl(c.href)).toEqual(c);
      }),
      RUNS,
    );
  });

  it("canonicalPath normalizes lexically and never Unicode-normalizes", () => {
    expect(canonicalPath("/a/./b/../c/")).toBe("/a/c");
    expect(canonicalPath("/")).toBe("/");
    expect(canonicalPath("//a//b")).toBe("/a/b");
    expect(canonicalPath("/w/café")).toBe("/w/café");
    expectInvalid(() => canonicalPath("a/b"));
    expectInvalid(() => canonicalPath("/a\0b"));
  });
});

// ---- 8. golden vectors ----------------------------------------------------------------------

interface Vector {
  name: string;
  kind: ApprovalKind;
  args: Args;
  bindingHash: string;
  grantKey: string;
}

/**
 * Pinned outputs (S05 release checklist §15.4 item 2): the expected hashes in
 * fixtures/binding-vectors.json were produced once by running this implementation and are
 * committed as-is. Any change to canonical JSON, the hash prefixes or a builder's field table
 * fails here; regenerate only with a deliberate, versioned binding change.
 */
describe("golden binding vectors (pinned outputs)", () => {
  const vectors = JSON.parse(
    readFileSync(new URL("./fixtures/binding-vectors.json", import.meta.url), "utf8"),
  ) as Vector[];

  it("has a vector table", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(5);
  });

  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const b = bindingFor(v.kind, v.args);
    expect(b.bindingHash).toBe(v.bindingHash);
    expect(b.grantKey).toBe(v.grantKey);
  });
});
