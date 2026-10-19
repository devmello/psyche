import { basename } from "node:path";
import { canonicalJSON, hashCanonical, isSha256Ref, type Sha256Ref, sha256 } from "@psyche/audit";
import { type ApprovalKind, type JsonObject, PsycheError } from "@psyche/protocol";
import { canonicalEmail, canonicalPath, canonicalUrl, TargetError } from "./targets.ts";

/**
 * Binding hashes and grant keys (security §3.5 is normative; data model §4.2 lists the same kinds
 * with a few extra fields, which are included here; S23 design-10/11/13/14 add more).
 *
 * `bindingHash = sha256("psyche.binding.v1|" + kind + "|" + canonicalJSON(fields))` over the strict
 * canonical JSON from `@psyche/audit` (throws on NaN, -0, Map, Date, lone surrogates; no NFC
 * folding). The coarser `grantKey = sha256("psyche.grantkey.v1|" + kind + "|" + canonicalJSON(key))`
 * is what reusable grants match. The executor recomputes the binding from the actual arguments
 * right before dispatch (`verifyBinding`).
 */

export function bindingHash(kind: string, fields: unknown): Sha256Ref {
  return sha256(`psyche.binding.v1|${kind}|${canonicalJSON(fields)}`);
}

export function grantKeyHash(kind: string, keyFields: unknown): Sha256Ref {
  return sha256(`psyche.grantkey.v1|${kind}|${canonicalJSON(keyFields)}`);
}

export interface Binding {
  kind: ApprovalKind;
  /** Exactly what is hashed into `bindingHash`. */
  fields: JsonObject;
  bindingHash: Sha256Ref;
  /** What reusable grants bind to; readable form stored as the grant's `subject`. */
  grantFields: JsonObject;
  grantKey: Sha256Ref;
}

// ---- argument shapes per kind -----------------------------------------------------------------

export interface ExecBindingArgs {
  argv: string[];
  /** Real path, resolved by the runner. */
  cwd: string;
  /** Environment explicitly passed to this command (not inherited). */
  env?: Record<string, string>;
  /** Real path of the executable after PATH lookup. */
  executable: string;
  /** Binary SHA-256, required for `exec_host`. */
  executableSha256?: string;
  sandboxId?: string;
  /** SHA-256 of stdin, when the command reads stdin (design-14). */
  stdinSha256?: string;
  network?: "none" | "proxy";
  /** Hashes of config files the executable reads from cwd, e.g. `.git/config` (design-14). */
  cwdConfigHashes?: Record<string, string>;
}

export interface EmailBindingArgs {
  account: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** SHA-256 of the text part. */
  bodySha256: string;
  /** SHA-256 of the HTML part, when one exists. */
  htmlSha256?: string;
  /** SHA-256 of the final MIME as serialized by the composer (design-11). */
  mimeSha256?: string;
  from?: string;
  sender?: string;
  replyTo?: string[];
  inReplyTo?: string;
  references?: string[];
  /** Any other outgoing header except Date / Message-ID / transport headers. */
  headers?: Record<string, string>;
  attachments?: { sha256: string; size: number; name: string }[];
}

export interface CalendarBindingArgs {
  account: string;
  calendarId: string;
  operation: "create" | "update" | "delete" | "respond";
  /** SHA-256 of the canonical event resource (incl. id for update / delete). */
  eventSha256: string;
}

export interface MessageBindingArgs {
  channel: string;
  account: string;
  recipient: string;
  bodySha256: string;
  attachments?: { sha256: string; size: number; name: string }[];
}

export interface FormSubmitBindingArgs {
  /** URL of the page holding the form. */
  pageUrl: string;
  /** Resolved form `action` (or the button's `formaction`). */
  action: string;
  method: "get" | "post" | "dialog";
  /** Every submitted field incl. hidden ones; credential fields carry their placeholder. */
  fields: Record<string, string>;
  submitRef?: string;
}

export const CREDENTIAL_FILL_FIELDS = ["username", "password", "totp", "token"] as const;
export type CredentialFillField = (typeof CREDENTIAL_FILL_FIELDS)[number];

export interface CredentialFillBindingArgs {
  itemId: string;
  /** Top-frame URL or origin the value goes to. */
  origin: string;
  /** `ref_N` from the snapshot. */
  ref: string;
  /** Element name / id / autocomplete as observed. */
  elementName: string;
  /** `input` type attribute, or `textarea` / `contenteditable` / `select`. */
  elementType: string;
  field: CredentialFillField;
  tabId?: string;
}

export interface PurchaseBindingArgs {
  /** Canonical merchant host or Link merchant name. */
  merchant: string;
  /** Integer minor units. */
  amountMinor: number;
  currency: string;
  lineItems: { name: string; qty: number; unitPriceMinor: number }[];
  paymentSourceId: string;
}

export interface FileWriteBindingArgs {
  realPath: string;
  operation: "create" | "overwrite" | "edit" | "append" | "delete" | "rename";
  /** SHA-256 of the resulting content (or `null` for delete). */
  contentSha256: string | null;
  mode?: number;
  /** Folder-grant root; the engine fills it from policy when absent. */
  root?: string;
}

export interface McpBindingArgs {
  serverId: string;
  tool: string;
  toolsListHash: string;
  /** SHA-256 of canonical arguments. */
  argsSha256: string;
}

export interface ComputerBindingArgs {
  app: string;
  tierRequired: "read" | "click" | "interact";
  action: string;
  elementRefSha256?: string;
}

export interface NewOriginBindingArgs {
  url: string;
  taskId?: string | null;
}

export interface GenericBindingArgs {
  tool: string;
  paramsHash: string;
  target?: string;
}

export type BindingArgsByKind = {
  exec: ExecBindingArgs;
  exec_host: ExecBindingArgs;
  send_email: EmailBindingArgs;
  calendar_write: CalendarBindingArgs;
  message_send: MessageBindingArgs;
  browser_submit: FormSubmitBindingArgs;
  credential_fill: CredentialFillBindingArgs;
  purchase: PurchaseBindingArgs;
  file_write: FileWriteBindingArgs;
  mcp_tool: McpBindingArgs;
  connector_action: McpBindingArgs | GenericBindingArgs;
  computer_action: ComputerBindingArgs;
  new_origin: NewOriginBindingArgs;
};

// ---- validation helpers -----------------------------------------------------------------------

function bad(kind: string, msg: string): never {
  throw new PsycheError("invalid_params", `binding ${kind}: ${msg}`);
}

function str(kind: string, name: string, v: unknown, opts: { empty?: boolean } = {}): string {
  if (typeof v !== "string") bad(kind, `${name} must be a string`);
  if (opts.empty !== true && v.length === 0) bad(kind, `${name} must not be empty`);
  return v;
}

function optStr(kind: string, name: string, v: unknown): string | undefined {
  return v === undefined ? undefined : str(kind, name, v);
}

function sha(kind: string, name: string, v: unknown): string {
  if (!isSha256Ref(v)) bad(kind, `${name} must be sha256:<64 hex>`);
  return v;
}

function optSha(kind: string, name: string, v: unknown): string | undefined {
  return v === undefined ? undefined : sha(kind, name, v);
}

function strArray(kind: string, name: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    bad(kind, `${name} must be a string array`);
  }
  return v as string[];
}

function int(kind: string, name: string, v: unknown, min = 0): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || Object.is(v, -0)) {
    bad(kind, `${name} must be an integer ≥ ${min}`);
  }
  return v;
}

function obj(kind: string, v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) bad(kind, "arguments must be an object");
  return v as Record<string, unknown>;
}

function emails(kind: string, name: string, v: unknown): string[] {
  if (v === undefined) return [];
  return [...new Set(strArray(kind, name, v).map((a) => canonicalEmail(a).address))].sort();
}

function attachments(kind: string, v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) bad(kind, "attachments must be an array");
  return v
    .map((a: unknown) => {
      const o = obj(kind, a);
      return `${sha(kind, "attachment.sha256", o.sha256)}:${int(kind, "attachment.size", o.size)}:${str(kind, "attachment.name", o.name)}`;
    })
    .sort();
}

function compact(o: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

/** Interpreter and loader variables that turn an env value into code execution (design-14). */
export const DANGEROUS_ENV = [
  /^LD_/,
  /^DYLD_/,
  /_OPTIONS$/,
  /^NODE_OPTIONS$/,
  /^PYTHONSTARTUP$/,
  /^PYTHONPATH$/,
  /^PYTHONHOME$/,
  /^PERL5OPT$/,
  /^PERL5LIB$/,
  /^RUBYOPT$/,
  /^RUBYLIB$/,
  /^BASH_ENV$/,
  /^ENV$/,
  /^PROMPT_COMMAND$/,
  /^GIT_/,
  /^PATH$/,
  /^SHELLOPTS$/,
  /^IFS$/,
];

export function dangerousEnvNames(env: Record<string, string> | undefined): string[] {
  if (env === undefined) return [];
  return Object.keys(env).filter((k) => DANGEROUS_ENV.some((re) => re.test(k)));
}

/** Executables that read code or config from cwd: `always` grants need their config hashes. */
export const CWD_CONFIG_EXECUTABLES = new Set([
  "git",
  "make",
  "gmake",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "node",
  "deno",
  "python",
  "python3",
  "pip",
  "pip3",
  "pytest",
  "uv",
  "poetry",
  "cargo",
  "go",
  "bundle",
  "rake",
  "ruby",
  "direnv",
  "mvn",
  "gradle",
  "swift",
  "xcodebuild",
  "just",
  "task",
  "docker",
  "docker-compose",
]);

export function readsCwdConfig(executable: string): boolean {
  const name = basename(executable);
  return CWD_CONFIG_EXECUTABLES.has(name) || CWD_CONFIG_EXECUTABLES.has(name.replace(/[\d.]+$/, ""));
}

// ---- builders ---------------------------------------------------------------------------------

function execBinding(kind: "exec" | "exec_host", raw: unknown): [JsonObject, JsonObject] {
  const a = obj(kind, raw);
  const argv = strArray(kind, "argv", a.argv);
  if (argv.length === 0) bad(kind, "argv must not be empty");
  if (argv.some((x) => x.includes("\0"))) bad(kind, "NUL in argv");
  const cwd = canonicalPath(str(kind, "cwd", a.cwd));
  const envObj = a.env === undefined ? {} : obj(kind, a.env);
  const env = Object.entries(envObj)
    .map(([k, v]) => `${k}=${str(kind, `env.${k}`, v, { empty: true })}`)
    .sort();
  const executable = canonicalPath(str(kind, "executable", a.executable));
  const executableSha256 = optSha(kind, "executableSha256", a.executableSha256);
  if (kind === "exec_host" && executableSha256 === undefined) {
    bad(kind, "exec_host binds the binary SHA-256 (executableSha256)");
  }
  const network = a.network === undefined ? "none" : a.network;
  if (network !== "none" && network !== "proxy") bad(kind, "network must be none | proxy");
  let cwdConfig: JsonObject | undefined;
  if (a.cwdConfigHashes !== undefined) {
    cwdConfig = {};
    for (const [file, h] of Object.entries(obj(kind, a.cwdConfigHashes))) {
      cwdConfig[file] = sha(kind, `cwdConfigHashes.${file}`, h);
    }
  }
  const fields = compact({
    argv,
    cwd,
    env,
    executable,
    executableSha256,
    sandboxId: optStr(kind, "sandboxId", a.sandboxId),
    stdinSha256: optSha(kind, "stdinSha256", a.stdinSha256),
    network,
    cwdConfigHashes: cwdConfig,
  });
  // Security §3.5: the grant key is "the same four fields" (plus the config hashes when bound).
  const key = compact({ argv, cwd, env, executable, executableSha256, cwdConfigHashes: cwdConfig });
  return [fields, key];
}

function emailBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "send_email";
  const a = obj(k, raw);
  const to = emails(k, "to", a.to);
  const cc = emails(k, "cc", a.cc);
  const bcc = emails(k, "bcc", a.bcc);
  if (to.length + cc.length + bcc.length === 0) bad(k, "no recipients");
  let headers: JsonObject | undefined;
  if (a.headers !== undefined) {
    headers = {};
    for (const [name, v] of Object.entries(obj(k, a.headers))) {
      headers[name.toLowerCase()] = str(k, `headers.${name}`, v, { empty: true });
    }
  }
  const account = str(k, "account", a.account);
  const fields = compact({
    account,
    to,
    cc,
    bcc,
    subject: str(k, "subject", a.subject, { empty: true }),
    bodySha256: sha(k, "bodySha256", a.bodySha256),
    htmlSha256: optSha(k, "htmlSha256", a.htmlSha256),
    mimeSha256: optSha(k, "mimeSha256", a.mimeSha256),
    from: a.from === undefined ? undefined : canonicalEmail(str(k, "from", a.from)).address,
    sender: a.sender === undefined ? undefined : canonicalEmail(str(k, "sender", a.sender)).address,
    replyTo: a.replyTo === undefined ? undefined : emails(k, "replyTo", a.replyTo),
    inReplyTo: optStr(k, "inReplyTo", a.inReplyTo),
    references: a.references === undefined ? undefined : strArray(k, "references", a.references),
    headers,
    attachments: attachments(k, a.attachments),
  });
  // Exact recipient set (security §3.5; design-11), never the recipient domain.
  const recipients = [...new Set([...to, ...cc, ...bcc])].sort();
  return [fields, { account, recipients }];
}

function calendarBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "calendar_write";
  const a = obj(k, raw);
  const operation = str(k, "operation", a.operation);
  if (!["create", "update", "delete", "respond"].includes(operation)) bad(k, "unknown operation");
  const account = str(k, "account", a.account);
  const calendarId = str(k, "calendarId", a.calendarId);
  return [
    { account, calendarId, operation, eventSha256: sha(k, "eventSha256", a.eventSha256) },
    { account, calendarId, operation },
  ];
}

function messageBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "message_send";
  const a = obj(k, raw);
  const channel = str(k, "channel", a.channel);
  const account = str(k, "account", a.account);
  const recipient = str(k, "recipient", a.recipient);
  return [
    {
      channel,
      account,
      recipient,
      bodySha256: sha(k, "bodySha256", a.bodySha256),
      attachments: attachments(k, a.attachments),
    },
    { channel, account, recipient },
  ];
}

function formBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "browser_submit";
  const a = obj(k, raw);
  const page = canonicalUrl(str(k, "pageUrl", a.pageUrl));
  const action = canonicalUrl(str(k, "action", a.action));
  const method = str(k, "method", a.method).toLowerCase();
  if (!["get", "post", "dialog"].includes(method)) bad(k, "method must be get | post | dialog");
  const fieldsObj = obj(k, a.fields);
  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(fieldsObj)) {
    values[name] = str(k, `fields.${name}`, v, { empty: true });
  }
  return [
    compact({
      origin: page.origin,
      pathname: page.pathname,
      action: action.href,
      actionOrigin: action.origin,
      method,
      fieldNames: Object.keys(values).sort(),
      valuesDigest: hashCanonical(values),
      submitRef: optStr(k, "submitRef", a.submitRef),
    }),
    { origin: page.origin, pathname: page.pathname },
  ];
}

function fillBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "credential_fill";
  const a = obj(k, raw);
  const field = str(k, "field", a.field);
  if (!(CREDENTIAL_FILL_FIELDS as readonly string[]).includes(field)) bad(k, "unknown field");
  const itemId = str(k, "itemId", a.itemId);
  const origin = canonicalUrl(str(k, "origin", a.origin)).origin;
  return [
    compact({
      itemId,
      origin,
      fieldSelector: {
        ref: str(k, "ref", a.ref),
        elementName: str(k, "elementName", a.elementName, { empty: true }),
        elementType: str(k, "elementType", a.elementType).toLowerCase(),
      },
      field,
      tabId: optStr(k, "tabId", a.tabId),
    }),
    { itemId, origin },
  ];
}

function purchaseBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "purchase";
  const a = obj(k, raw);
  const currency = str(k, "currency", a.currency);
  if (!/^[A-Z]{3}$/.test(currency)) bad(k, "currency must be ISO 4217");
  if (!Array.isArray(a.lineItems) || a.lineItems.length === 0) bad(k, "lineItems required");
  const lineItems = a.lineItems
    .map((li: unknown) => {
      const o = obj(k, li);
      return {
        name: str(k, "lineItem.name", o.name),
        qty: int(k, "lineItem.qty", o.qty, 1),
        unitPrice: int(k, "lineItem.unitPriceMinor", o.unitPriceMinor),
      };
    })
    .sort((x, y) => (canonicalJSON(x) < canonicalJSON(y) ? -1 : 1));
  const merchantRaw = str(k, "merchant", a.merchant);
  let merchant = merchantRaw;
  try {
    merchant = canonicalUrl(merchantRaw.includes("://") ? merchantRaw : `https://${merchantRaw}`).host;
  } catch (e) {
    if (!(e instanceof TargetError)) throw e;
  }
  const fields = {
    merchant,
    amountMinor: int(k, "amountMinor", a.amountMinor, 1),
    currency,
    lineItemsSha256: hashCanonical(lineItems),
    paymentSourceId: str(k, "paymentSourceId", a.paymentSourceId),
  };
  // No reusable grant: `once` only. The key is the binding itself.
  return [fields, fields];
}

function fileBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "file_write";
  const a = obj(k, raw);
  const operation = str(k, "operation", a.operation);
  if (!["create", "overwrite", "edit", "append", "delete", "rename"].includes(operation)) {
    bad(k, "unknown operation");
  }
  const realPath = canonicalPath(str(k, "realPath", a.realPath));
  const contentSha256 =
    a.contentSha256 === null ? null : sha(k, "contentSha256", a.contentSha256);
  if (contentSha256 === null && operation !== "delete") bad(k, "contentSha256 required");
  const root = a.root === undefined ? realPath : canonicalPath(str(k, "root", a.root));
  return [
    compact({
      realPath,
      operation,
      contentSha256,
      mode: a.mode === undefined ? undefined : int(k, "mode", a.mode),
    }),
    { root, operation },
  ];
}

function mcpBinding(kind: "mcp_tool" | "connector_action", raw: unknown): [JsonObject, JsonObject] {
  const a = obj(kind, raw);
  const serverId = str(kind, "serverId", a.serverId);
  const tool = str(kind, "tool", a.tool);
  const toolsListHash = sha(kind, "toolsListHash", a.toolsListHash);
  return [
    { serverId, tool, toolsListHash, argsSha256: sha(kind, "argsSha256", a.argsSha256) },
    { serverId, tool, toolsListHash },
  ];
}

function computerBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "computer_action";
  const a = obj(k, raw);
  const app = str(k, "app", a.app);
  const tierRequired = str(k, "tierRequired", a.tierRequired);
  if (!["read", "click", "interact"].includes(tierRequired)) bad(k, "unknown tier");
  const action = str(k, "action", a.action);
  return [
    compact({ app, tierRequired, action, elementRefSha256: optSha(k, "elementRefSha256", a.elementRefSha256) }),
    { app, tierRequired },
  ];
}

function newOriginBinding(raw: unknown): [JsonObject, JsonObject] {
  const k = "new_origin";
  const a = obj(k, raw);
  const origin = canonicalUrl(str(k, "url", a.url)).origin;
  const taskId = a.taskId == null ? null : str(k, "taskId", a.taskId);
  return [{ origin, taskId }, { origin }];
}

function genericBinding(kind: string, raw: unknown): [JsonObject, JsonObject] {
  const a = obj(kind, raw);
  const tool = str(kind, "tool", a.tool);
  const target = optStr(kind, "target", a.target);
  return [
    compact({ tool, paramsHash: sha(kind, "paramsHash", a.paramsHash), target }),
    compact({ tool, target }),
  ];
}

/** Kinds with a dedicated field table. Everything else binds `{tool, paramsHash, target}`. */
export const DEDICATED_BINDING_KINDS: readonly ApprovalKind[] = [
  "exec",
  "exec_host",
  "send_email",
  "calendar_write",
  "message_send",
  "browser_submit",
  "credential_fill",
  "purchase",
  "file_write",
  "mcp_tool",
  "computer_action",
  "new_origin",
];

/** Build the binding for `kind` from kind-specific arguments; throws `invalid_params`. */
export function bindingFor(kind: ApprovalKind, args: unknown): Binding {
  let pair: [JsonObject, JsonObject];
  switch (kind) {
    case "exec":
    case "exec_host":
      pair = execBinding(kind, args);
      break;
    case "send_email":
      pair = emailBinding(args);
      break;
    case "calendar_write":
      pair = calendarBinding(args);
      break;
    case "message_send":
      pair = messageBinding(args);
      break;
    case "browser_submit":
      pair = formBinding(args);
      break;
    case "credential_fill":
      pair = fillBinding(args);
      break;
    case "purchase":
      pair = purchaseBinding(args);
      break;
    case "file_write":
      pair = fileBinding(args);
      break;
    case "mcp_tool":
      pair = mcpBinding(kind, args);
      break;
    case "connector_action": {
      const a = obj(kind, args);
      pair = a.serverId !== undefined ? mcpBinding(kind, args) : genericBinding(kind, args);
      break;
    }
    case "computer_action":
      pair = computerBinding(args);
      break;
    case "new_origin":
      pair = newOriginBinding(args);
      break;
    default:
      pair = genericBinding(kind, args);
  }
  const [fields, grantFields] = pair;
  return {
    kind,
    fields,
    bindingHash: bindingHash(kind, fields),
    grantFields,
    grantKey: grantKeyHash(kind, grantFields),
  };
}

/** The fallback binding when no kind-specific arguments were given: `{tool, paramsHash, target}`. */
export function genericBindingFor(kind: ApprovalKind, args: GenericBindingArgs): Binding {
  const [fields, grantFields] = genericBinding(kind, args);
  return {
    kind,
    fields,
    bindingHash: bindingHash(kind, fields),
    grantFields,
    grantKey: grantKeyHash(kind, grantFields),
  };
}
