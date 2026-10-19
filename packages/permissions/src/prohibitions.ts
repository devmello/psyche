import { posix } from "node:path";
import { cardDigits, findSensitive } from "@psyche/audit";
import { PLACEHOLDER_PATTERN } from "@psyche/protocol";
import { dangerousEnvNames } from "./binding.ts";
import { type CanonicalUrl, canonicalUrl, isLoopbackAddress, isLoopbackName, isUnder, TargetError } from "./targets.ts";
import type { PolicyCall, PolicyContext } from "./types.ts";

/**
 * Hard prohibitions (security §3.9, §3.10; architecture §4.6; feature F11). Not configurable and
 * evaluated first: a match is terminal. Each returns a rule id `prohibition:<id>` for the audit log.
 * Two of them do not deny outright: permanent deletion needs the owner's typed confirmation word on
 * the card, and third-party account creation always asks.
 */

export type ProhibitionResult =
  | { effect: "deny"; id: string; reason: string }
  | { effect: "confirm"; id: string; reason: string; word: string }
  | { effect: "ask"; id: string; reason: string };

export interface LoopbackCheck {
  ok: boolean;
  reason: string;
}

/**
 * Decides whether a loopback URL is the owner's own project (security §3.10, S23 design-03): the
 * host must resolve to a loopback address, the listening socket must belong to a process Psyche
 * started this session, and the port must not be one of Psyche's own.
 */
export interface LocalProjectVerifier {
  check(url: CanonicalUrl): Promise<LoopbackCheck>;
}

/** Default: no loopback origin is the owner's project (fail closed). */
export const DENY_ALL_LOOPBACK: LocalProjectVerifier = {
  check: async () => ({ ok: false, reason: "unverified" }),
};

export interface LocalProjectProbes {
  /** Addresses the host resolves to, resolved by Psyche (never trusting the name). */
  resolve(host: string): Promise<string[]>;
  /** PID listening on 127.0.0.1/::1 at `port`, if any. */
  listenerPid(port: number): Promise<number | undefined>;
  /** Whether `pid` descends from a process Psyche spawned this session from a granted folder. */
  spawnedByPsyche(pid: number): Promise<boolean>;
  /** Psyche's own ports: Gateway, browser bridge, CDP, OAuth loopback listener. */
  psychePorts: readonly number[];
}

/** Well-known local services that are never "the owner's project". */
export const LOCAL_SERVICE_PORTS = [631, 7979, 9222, 11434];

export function createLocalProjectVerifier(probes: LocalProjectProbes): LocalProjectVerifier {
  return {
    async check(url) {
      const port = url.port ?? (url.scheme === "https" ? 443 : 80);
      if (probes.psychePorts.includes(port)) return { ok: false, reason: "psyche_port" };
      if (LOCAL_SERVICE_PORTS.includes(port)) return { ok: false, reason: "local_service_port" };
      const addrs = await probes.resolve(url.host.replace(/^\[|\]$/g, ""));
      if (addrs.length === 0 || !addrs.every(isLoopbackAddress)) {
        return { ok: false, reason: "resolved_non_loopback" };
      }
      const pid = await probes.listenerPid(port);
      if (pid === undefined) return { ok: false, reason: "no_listener" };
      if (!(await probes.spawnedByPsyche(pid))) return { ok: false, reason: "listener_not_spawned_by_psyche" };
      return { ok: true, reason: "own_project" };
    },
  };
}

export interface ProhibitionEnv {
  /** `$PSYCHE_HOME`, whose control-plane files no tool call may write. */
  psycheHome?: string;
  /** Origins of the Gateway UI (loopback bind, `publicOrigin`). */
  gatewayOrigins: readonly string[];
  localProject: LocalProjectVerifier;
  /** Env names the owner typed on a card or in policy (`exec.allowEnv`). */
  allowEnv: readonly string[];
}

/** Stripe and other providers' published test card numbers (allowed only under §3.10). */
export const PUBLISHED_TEST_CARDS = new Set([
  "4242424242424242",
  "4000056655665556",
  "5555555555554444",
  "2223003122003222",
  "5200828282828210",
  "5105105105105100",
  "378282246310005",
  "371449635398431",
  "6011111111111117",
  "6011000990139424",
  "3056930009020004",
  "36227206271667",
  "3566002020360505",
  "6200000000000005",
  "4111111111111111",
  "4000000000000002",
  "4000000000009995",
]);

// ---- helpers ----------------------------------------------------------------------------------

interface StringAt {
  path: string;
  value: string;
}

function strings(value: unknown, path = "$", out: StringAt[] = [], depth = 0): StringAt[] {
  if (depth > 32) return out;
  if (typeof value === "string") out.push({ path, value });
  else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${path}[${i}]`, out, depth + 1));
  else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      strings(k, `${path}.<key>`, out, depth + 1);
      strings(v, `${path}.${k}`, out, depth + 1);
    }
  }
  return out;
}

const TYPING_TOOL = /(^|\.)(type|fill|key|keys|insert_text|set_value|paste)$/;
const TRANSFER_TOOL =
  /(^|[._])(transfer|transfers|wire|withdraw|withdrawal|trade|trades|order_stock|send_money|payout|swap|stake|unstake|bridge_funds)([._]|$)/i;
const TRANSFER_NAMESPACE = /^(bank|banking|broker|brokerage|crypto|exchange|wallet|venmo|zelle|cashapp)\./i;
const PERMANENT_DELETE_TOOL =
  /(^|[._])(purge|expunge|empty_trash|delete_permanently|permanent_delete|permanently_delete|hard_delete|destroy|wipe|shred)([._]|$)/i;
const ACCOUNT_CREATION_TOOL = /(^|[._])(signup|sign_up|register|create_account|account_create)([._]|$)/i;
const CAPTCHA = /captcha|recaptcha|hcaptcha|turnstile|arkose|funcaptcha/i;
const CONTROL_PLANE_TOOL =
  /^(settings|config|grants|approvals|devices|device|pairing|policy|permissions|vault|security|gateway)[._]/i;
const PERMANENT_RM = new Set(["rm", "rmdir", "shred", "srm", "unlink"]);
export const CONFIRMATION_WORD = "DELETE";

/** Paths Safari, Passwords and the keychain keep credentials in (macos notes, KQ7). */
const SYSTEM_CREDENTIAL_PATHS = [
  /^\/Users\/[^/]+\/Library\/Keychains(\/|$)/,
  /^\/Library\/Keychains(\/|$)/,
  /^\/Users\/[^/]+\/Library\/Safari(\/|$)/,
  /^\/Users\/[^/]+\/Library\/Containers\/com\.apple\.Safari(\/|$)/,
  /^\/Users\/[^/]+\/Library\/Cookies(\/|$)/,
  /^\/Users\/[^/]+\/Library\/Application Support\/com\.apple\.Passwords/,
  /^\/Users\/[^/]+\/Library\/Group Containers\/[^/]*com\.apple\.Passwords/,
  /^\/private\/var\/db\/SystemKey/,
];

function targetUrl(call: PolicyCall): CanonicalUrl | "invalid" | undefined {
  if (call.target?.kind !== "origin") return undefined;
  try {
    return canonicalUrl(call.target.value);
  } catch (e) {
    if (e instanceof TargetError) return "invalid";
    throw e;
  }
}

function targetPath(call: PolicyCall): string | undefined {
  if (call.target?.kind !== "path") return undefined;
  return call.target.value.startsWith("/") ? posix.normalize(call.target.value) : undefined;
}

function deny(id: string, reason: string): ProhibitionResult {
  return { effect: "deny", id: `prohibition:${id}`, reason };
}

// ---- the checks -------------------------------------------------------------------------------

export async function checkProhibitions(
  call: PolicyCall,
  ctx: PolicyContext,
  env: ProhibitionEnv,
  effectiveKind: string,
): Promise<ProhibitionResult | undefined> {
  const meta = call.meta ?? {};
  const tool = call.tool;
  const params = strings(call.params);
  const writePlus = call.sideEffect !== "none" && call.sideEffect !== "read";

  // Instructions found in content are never followed (security §3.9).
  if (ctx.initiator === "content") {
    return deny("instruction_from_content", "the call was requested by content, not the owner");
  }

  // Edits to the Permission Broker, grant ledger, security config or pairing from a tool call.
  if (CONTROL_PLANE_TOOL.test(tool)) {
    return deny("control_plane", "settings, grants, devices and pairing have no tool path");
  }
  const path = targetPath(call);
  if (path !== undefined && env.psycheHome !== undefined) {
    const home = posix.normalize(env.psycheHome);
    if (isUnder(path, posix.join(home, "vault"))) return deny("psyche_state", "the vault is not a file target");
    const controlPlane = ["config.json", "state", "audit", "run", "policy.json"].some((p) =>
      isUnder(path, posix.join(home, p)),
    );
    if (controlPlane && call.sideEffect !== "read" && call.sideEffect !== "none") {
      return deny("psyche_state", "Psyche's config, state and audit are not writable by tools");
    }
  }
  if (path !== undefined && SYSTEM_CREDENTIAL_PATHS.some((re) => re.test(path))) {
    return deny("system_credentials", "Safari, Passwords and keychain credentials are never read");
  }

  // A model-visible secret is never used, even one the owner pasted.
  for (const s of params) {
    const hit = findSensitive(s.value).find((m) =>
      ["private_key", "api_key", "bearer_token", "jwt", "url_credentials"].includes(m.kind),
    );
    if (hit !== undefined) {
      return deny("visible_secret", `a ${hit.kind} is visible in the arguments; use the vault`);
    }
  }

  // Placeholders resolve only in fill-capable executors (security §4.5).
  const fillTool = /^credentials\./.test(tool);
  for (const s of params) {
    if (!PLACEHOLDER_PATTERN.test(s.value)) continue;
    const execEnv = (effectiveKind === "exec" || effectiveKind === "exec_host") && s.path.startsWith("$.env.");
    if (!fillTool && !execEnv) {
      return deny("placeholder_outside_fill", "credential placeholders are only resolved by credentials.request");
    }
  }

  // Passwords are typed by the owner or filled from the vault, never typed by the model.
  const field = meta.field;
  const passwordField =
    field?.secure === true ||
    field?.type?.toLowerCase() === "password" ||
    /password/i.test(field?.autocomplete ?? "");
  if (TYPING_TOOL.test(tool) && passwordField) {
    return deny("password_typing", "the agent never types into a password field");
  }

  // Credential fills only into a matching field class (S23 design-01).
  if (effectiveKind === "credential_fill") {
    const mismatch = fillFieldMismatch(call.binding);
    if (mismatch !== undefined) return deny("fill_field_mismatch", mismatch);
  }

  // CAPTCHA: never solved, bypassed or outsourced.
  if (meta.captcha === true || CAPTCHA.test(tool) || params.some((s) => s.path.includes("<key>") && CAPTCHA.test(s.value))) {
    return deny("captcha", "CAPTCHAs are never solved or bypassed");
  }
  if (field !== undefined && CAPTCHA.test(`${field.name ?? ""} ${field.role ?? ""}`)) {
    return deny("captcha", "CAPTCHAs are never solved or bypassed");
  }

  // Financial transfers and trades.
  if (TRANSFER_TOOL.test(tool) || TRANSFER_NAMESPACE.test(tool)) {
    return deny("financial_transfer", "Psyche never moves money or trades");
  }

  // Loopback origins that are not the owner's own project (§3.10, design-03).
  const url = targetUrl(call);
  if (url === "invalid") return deny("invalid_target", "the target URL is not canonical (userinfo, opaque or malformed)");
  let loopbackOwned = false;
  if (url !== undefined) {
    if (env.gatewayOrigins.includes(url.origin)) {
      return deny("gateway_origin", "the agent never acts on the Psyche Gateway's own UI");
    }
    if (isLoopbackName(url.host) || isLoopbackAddress(url.host)) {
      const check = await env.localProject.check(url);
      if (!check.ok) return deny("loopback_not_owned", `loopback origin is not the owner's project (${check.reason})`);
      loopbackOwned = true;
    }
  }
  if (meta.testCredential === true && !loopbackOwned) {
    return deny("test_credential_scope", "test credentials are only used on the owner's own local project");
  }

  // Card numbers, bank accounts and government identifiers are never entered.
  if (writePlus || TYPING_TOOL.test(tool)) {
    for (const s of params) {
      for (const m of findSensitive(s.value)) {
        if (m.kind === "card_number") {
          const digits = cardDigits(s.value.slice(m.index, m.index + m.length));
          if (digits !== undefined && PUBLISHED_TEST_CARDS.has(digits) && loopbackOwned) continue;
          return deny("card_entry", "card numbers are never entered; purchases go through Link");
        }
        if (m.kind === "iban") return deny("bank_account_entry", "bank account numbers are never entered");
        if (m.kind === "us_ssn") return deny("government_id_entry", "government identifiers are never entered");
      }
    }
  }

  // Dangerous interpreter / loader variables in an exec env (design-14).
  if (effectiveKind === "exec" || effectiveKind === "exec_host") {
    const envVars = execEnv(call);
    const bad = dangerousEnvNames(envVars).filter((n) => !env.allowEnv.includes(n));
    if (bad.length > 0) return deny("dangerous_env", `exec env sets ${bad.join(", ")}`);
  }

  // Untrusted-derived writes never reach the protected memory files (security §3.6, §8).
  if (effectiveKind === "memory_protected_write" && ctx.taint) {
    return deny("untrusted_memory_promotion", "a tainted turn cannot write USER.md / MEMORY.md / SOUL.md / AGENTS.md");
  }

  // Permanent deletion needs the owner's typed confirmation word.
  if (meta.permanentDelete === true || PERMANENT_DELETE_TOOL.test(tool) || permanentRm(call, effectiveKind)) {
    const claims = params.some((s) => /(^|\.)(confirmation|typedConfirmation|confirm)$/.test(s.path));
    if (claims) return deny("self_confirmed_delete", "the confirmation word must come from the owner, not the call");
    return {
      effect: "confirm",
      id: "prohibition:permanent_delete",
      reason: `permanent deletion needs the owner to type ${CONFIRMATION_WORD}`,
      word: CONFIRMATION_WORD,
    };
  }

  // Third-party account creation always asks.
  if (meta.accountCreation === true || ACCOUNT_CREATION_TOOL.test(tool)) {
    return { effect: "ask", id: "prohibition:account_creation", reason: "creating a third-party account needs approval" };
  }
  return undefined;
}

function execEnv(call: PolicyCall): Record<string, string> | undefined {
  const fromBinding = (call.binding as { env?: Record<string, string> } | undefined)?.env;
  const fromParams = (call.params as { env?: Record<string, string> } | undefined)?.env;
  const env = fromBinding ?? fromParams;
  return typeof env === "object" && env !== null ? env : undefined;
}

function permanentRm(call: PolicyCall, kind: string): boolean {
  if (kind !== "exec_host") return false;
  const argv = (call.binding as { argv?: unknown } | undefined)?.argv ?? (call.params as { argv?: unknown })?.argv;
  if (!Array.isArray(argv) || typeof argv[0] !== "string") return false;
  return PERMANENT_RM.has(posix.basename(argv[0]));
}

function fillFieldMismatch(binding: unknown): string | undefined {
  if (typeof binding !== "object" || binding === null) return undefined;
  const b = binding as { field?: string; elementType?: string };
  const t = (b.elementType ?? "").toLowerCase();
  if (["textarea", "contenteditable", "select", "hidden", "search", "url"].includes(t)) {
    return `a credential is never filled into a ${t} element`;
  }
  switch (b.field) {
    case "password":
      return t === "password" ? undefined : `password fields fill only input[type=password], not ${t || "unknown"}`;
    case "username":
      return ["text", "email", "tel"].includes(t) ? undefined : `usernames fill only text/email inputs, not ${t || "unknown"}`;
    case "totp":
      return ["text", "number", "tel", "password"].includes(t) ? undefined : `one-time codes fill only short inputs, not ${t || "unknown"}`;
    case "token":
      return ["text", "password"].includes(t) ? undefined : `tokens fill only text/password inputs, not ${t || "unknown"}`;
    default:
      return undefined;
  }
}
