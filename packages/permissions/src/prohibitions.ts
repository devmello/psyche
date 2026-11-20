import { createHash } from "node:crypto";
import { posix } from "node:path";
import { cardDigits, findSensitiveNormalized as findSensitive } from "@psyche/audit";
import { canonicalHostPath, isAbsoluteHostPath, slashHostPath } from "@psyche/hostfs";
import { PLACEHOLDER_PATTERN, PROTECTED_MEMORY_FILES } from "@psyche/protocol";
import {
  FINANCIAL_BLOCK_REASON,
  financialBlock,
  isTradeOrTransferText,
} from "@psyche/protocol/financial-block";
import { dangerousEnvNames } from "./binding.ts";
import { SEND_KINDS } from "./connector-matrix.ts";
import { outboundSendDecision } from "./outbound.ts";
import {
  type CanonicalUrl,
  canonicalUrl,
  isLoopbackAddress,
  isLoopbackName,
  TargetError,
} from "./targets.ts";
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
  | { effect: "ask"; id: string; reason: string; deviceOnly?: true };

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
      if (!(await probes.spawnedByPsyche(pid)))
        return { ok: false, reason: "listener_not_spawned_by_psyche" };
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

/**
 * Stripe's and other providers' published test card numbers (allowed only under §3.10), kept as
 * SHA-256 of the digits so no card-shaped literal sits in the source (the repo secret scan).
 */
export const PUBLISHED_TEST_CARD_HASHES: ReadonlySet<string> = new Set([
  "477bba133c182267fe5f086924abdc5db71f77bfc27f01f2843f2cdc69d89f05",
  "68594afe9c9cda525f6aca7a7316ca06c9db4952ba6f5217944581dc4a07e0b6",
  "2f725bbd1f405a1ed0336abaf85ddfeb6902a9984a76fd877c3b5cc3b5085a82",
  "576c15a8072461c216efb9bd7306a6fc6039b43a6763c4c1a05930a2dd7b788f",
  "b40e9bc7a74d50ab4f006ab0d3e85a8b96a5092989d5934623555f94ae48c836",
  "304945e91de3deff52a61d08733141d72dd42ec9d47972f1060534d54c0c7f90",
  "3a134ef77d4e2e4cdad2d2945ff1f76c1a23296c93c851f6244220a8cedea130",
  "53a8fc816e63b7a5ccd17aaff93f28bcf13abbf418209dcd93947722d7c326ba",
  "19ff47cc8024c133d5845d3f8938caca289929031e7d508c3adf7adff177f0c2",
  "d8086d483c15c711ebba19f966b97d3c2adcba74025ff8d7e07c3698c9531deb",
  "10f6a49b3088d98187bf43161da352a767662efa07658531b811edcf1b34fed6",
  "20e6583871d36495e2beca33ecfc369c90a53f32987a81b2ce732df48b438c7b",
  "d79449f462cec9af0d857c3e1af888d4fa8bbdaa511b9eaaafcd2805c4ea6471",
  "7cbcc57fc39e4317fa8d55bb2d442f829f0c21ffa4c4683c48e7263faf1a871a",
  "9bbef19476623ca56c17da75fd57734dbf82530686043a6e491c6d71befe8f6e",
  "acd08f29a41f2e55ab0c4f774b1562b03ff01a905ed5b100f4facd43af572b1b",
  "e5de3c3d9fcb43b15abddceb57a9f70055fdfb4b504765336054c926abeb88de",
]);

export function isPublishedTestCard(digits: string): boolean {
  return PUBLISHED_TEST_CARD_HASHES.has(createHash("sha256").update(digits).digest("hex"));
}

// ---- helpers ----------------------------------------------------------------------------------

interface StringAt {
  path: string;
  value: string;
  tooDeep?: boolean;
}

function strings(value: unknown, path = "$", out: StringAt[] = [], depth = 0): StringAt[] {
  if (depth > 32) {
    out.push({ path: `${path}.<too_deep>`, value: "", tooDeep: true });
    return out;
  }
  if (typeof value === "string") out.push({ path, value });
  else if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) strings(v, `${path}[${i}]`, out, depth + 1);
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      strings(k, `${path}.<key>`, out, depth + 1);
      strings(v, `${path}.${k}`, out, depth + 1);
    }
  }
  return out;
}

const TYPING_TOOL = /(^|\.)(type|fill|key|keys|insert_text|set_value|paste)$/;
/** Lowercase words of a tool name: separators `._-`, camelCase and `mcp__server__tool` split. */
export function toolWords(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}
const TRANSFER_WORDS = new Set([
  "transfer",
  "transfers",
  "wire",
  "withdraw",
  "withdrawal",
  "trade",
  "trades",
  "payout",
  "payouts",
  "swap",
  "stake",
  "unstake",
  "remit",
  "remittance",
]);
const TRANSFER_PAIRS = [
  ["send", "money"],
  ["send", "payment"],
  ["send", "funds"],
  ["move", "money"],
  ["create", "trade"],
  // On-chain and ACH sends: `send_transaction`, `sendTransaction`, `sign_tx`, `create_ach`.
  ["send", "transaction"],
  ["sign", "transaction"],
  ["broadcast", "transaction"],
  ["send", "tx"],
  ["sign", "tx"],
  ["create", "ach"],
  ["send", "ach"],
  ["initiate", "ach"],
  ["payment", "initiation"],
  ["initiate", "payment"],
  // Contract writes and token allowances (`write_contract`, `call_contract_function`,
  // `approve_token`): they move tokens whatever the server is called.
  ["write", "contract"],
  ["call", "contract"],
  ["execute", "contract"],
  ["approve", "token"],
  ["approve", "tokens"],
  ["approve", "spender"],
  ["approve", "allowance"],
  ["approve", "erc20"],
  ["approve", "erc721"],
  ["approve", "erc1155"],
  ["approve", "nft"],
  ["increase", "allowance"],
];
// `place_order` and `submit_order` alone are not here: a shop, a restaurant or a ticket seller has
// them too. An order of stock or crypto is caught by `isTradeOrTransferText`, and any order on a
// brokerage or exchange namespace by `FINANCIAL_NAMESPACES`.
/** MCP servers / namespaces whose actions move money or trade. */
const FINANCIAL_NAMESPACES = new Set([
  "bank",
  "banking",
  "crypto",
  "exchange",
  "wallet",
  "venmo",
  "zelle",
  "cashapp",
  "alpaca",
  "coinbase",
  "robinhood",
  "binance",
  "kraken",
  "schwab",
  "fidelity",
  "wise",
  "revolut",
  "ibkr",
  "interactivebrokers",
  "etrade",
  "tdameritrade",
  "tradestation",
  "webull",
  "vanguard",
  "tradier",
  "bitstamp",
  "bybit",
  "okx",
  "kucoin",
  "metamask",
  "uniswap",
  "ledger",
  "remitly",
  "westernunion",
  "moneygram",
  "zellepay",
  "ib",
  "tws",
  "ccxt",
  "polymarket",
  "kalshi",
  "hyperliquid",
  "tastytrade",
  "firstrade",
  "trading212",
  "degiro",
  "etoro",
  "saxo",
  "moomoo",
  "zerodha",
  "bitfinex",
  "bitget",
  "mexc",
  "bitpanda",
  "bitso",
  "upbit",
  "bithumb",
  "bitflyer",
  "phantom",
  "dydx",
]);
/** Banks, by the name an MCP server for one would carry (`mcp__chase__pay`). */
const BANK_NAMESPACES = [
  "chase",
  "bankofamerica",
  "wellsfargo",
  "citi",
  "citibank",
  "capitalone",
  "usbank",
  "pnc",
  "tdbank",
  "truist",
  "hsbc",
  "barclays",
  "santander",
  "scotiabank",
  "cibc",
  "commerzbank",
  "bbva",
  "sofi",
  "chime",
  "usaa",
  "navyfederal",
  "monzo",
  "n26",
  "starling",
  "nubank",
];
for (const b of BANK_NAMESPACES) FINANCIAL_NAMESPACES.add(b);
/**
 * Words that are financial only on their own: a namespace containing "broker" (`mybroker`) or
 * with the word "trading" is a brokerage's, unless another word says it is a message broker
 * (`mqtt-broker`, `kafka_broker`) or a card game (`pokemon_trading`).
 */
/** Inside a word ("mybroker"); "trading" only as a word of its own ("libtrading" is a library). */
const GENERIC_FINANCIAL_PARTS = ["broker"];
const GENERIC_FINANCIAL_TOKENS = ["trading", "broker", "brokerage"];
/**
 * Words of a namespace that say it is a message broker or a card game, matched as whole words
 * (`mqtt-broker`, `pokemon_trading`), or as the end of one for a bus (`eventbus`, `omnibus`):
 * "business_trading" and "trading_bus" are still trading.
 */
const NOT_FINANCIAL_QUALIFIERS = [
  "message",
  "messages",
  "mqtt",
  "kafka",
  "rabbit",
  "rabbitmq",
  "amqp",
  "nats",
  "redis",
  "pubsub",
  "queue",
  "card",
  "cards",
  "pokemon",
  "tcg",
  "game",
  "games",
  "yugioh",
  "magic",
];
/** Message buses by name, whole words only: "airbus" and "trading_bus" are not one. */
const BUS_TOKENS = new Set([
  "eventbus",
  "servicebus",
  "omnibus",
  "messagebus",
  "msgbus",
  "databus",
  "eventbridge",
]);
/** A tool verb that trades whatever the server calls itself. */
const TRADE_ACTS = new Set(["buy", "sell", "order", "orders", "bet", "trade", "short", "swap"]);

/**
 * A tool that only reads is not a trade, even on a brokerage's or an exchange's server: its first
 * word is one of these, it names what it reads, and no action word appears anywhere in it
 * (`fetch_and_create_order`, `get_or_place_order` and a bare `fetch` or `query`, which can be
 * any request, are not reads).
 */
const ACTION_WORDS = new Set([
  "order",
  "orders",
  "buy",
  "sell",
  "execute",
  "submit",
  "place",
  "create",
  "send",
  "pay",
  "transfer",
  "cancel",
  "out",
  "checkout",
  "liquidate",
  "open",
  "close",
  "fund",
  "approve",
  "sign",
  "write",
  "swap",
  "withdraw",
  "trade",
  "new",
  "add",
  "confirm",
  "call",
  "invoke",
  "request",
  "post",
  "put",
  "delete",
  "update",
  "set",
  "modify",
  "replace",
  "mint",
  "burn",
  "bridge",
  "stake",
  "deposit",
  "then",
  "and",
  "or",
]);
/** A read verb that alone can be any request: it needs to name what it reads. */
const GENERIC_READS = new Set(["fetch", "query", "request", "call", "get"]);
/** What a passthrough reads: `query_private` on Kraken can add orders, `fetch_raw` anything. */
const PASSTHROUGH_WORDS = new Set(["private", "raw", "any", "endpoint", "api", "rpc", "proxy"]);
/** Read nouns that contain an action word: an order book, a list of open orders. */
const READ_NOUNS: readonly (readonly string[])[] = [
  ["order", "book"],
  ["open", "orders"],
  ["orders"],
  ["order", "history"],
  ["order", "status"],
];

/** The tool's words with the read nouns taken out (`get_open_orders` → `get`, `list_orders` → `list`). */
function withoutReadNouns(words: readonly string[]): string[] {
  const out = [...words];
  for (const phrase of READ_NOUNS) {
    for (let i = 0; i + phrase.length <= out.length; i++) {
      if (phrase.every((w, k) => out[i + k] === w)) out.splice(i, phrase.length, "_read");
    }
  }
  return out;
}
const READ_VERBS = new Set([
  "get",
  "list",
  "read",
  "fetch",
  "search",
  "find",
  "view",
  "show",
  "describe",
  "lookup",
  "query",
  "check",
  "quote",
  "quotes",
  "estimate",
  "preview",
  "history",
  "status",
]);

export function isFinancialTransfer(tool: string): boolean {
  const words = toolWords(tool);
  if (words.some((w) => TRANSFER_WORDS.has(w))) return true;
  if (TRANSFER_PAIRS.some(([a, b]) => words.includes(a ?? "") && words.includes(b ?? "")))
    return true;
  // `buy_stock`, `sellShares`, `place_stock_order`, `send_bitcoin`, `swap_tokens`.
  if (isTradeOrTransferText(tool)) return true;
  const ns = tool.startsWith("mcp__") ? (tool.split("__")[1] ?? "") : (tool.split(/[._]/)[0] ?? "");
  const lower = ns.toLowerCase();
  // `interactive-brokers` and `cash_app` read as `interactivebrokers` and `cashapp`; `robinhood-mcp`
  // and `alpaca-mcp-server` have the broker as one of their words.
  const compact = lower.replace(/[^a-z0-9]+/g, "");
  const tokens = toolWords(ns);
  // The tool's own words, past the server name.
  const own = tool.startsWith("mcp__")
    ? tool.split("__").slice(2).join("_")
    : tool.slice(ns.length);
  const ownRaw = toolWords(own);
  // A message bus or a card game is not a brokerage, but only while the tool does not trade:
  // `trading_games_broker__buy` and `sports-trading__place_bet` still trade.
  const trades = ownRaw.some((w) => TRADE_ACTS.has(w));
  const qualified =
    !trades && tokens.some((t) => NOT_FINANCIAL_QUALIFIERS.includes(t) || BUS_TOKENS.has(t));
  const financial =
    FINANCIAL_NAMESPACES.has(compact) ||
    tokens.some((t) => FINANCIAL_NAMESPACES.has(t)) ||
    (!qualified &&
      (GENERIC_FINANCIAL_PARTS.some((part) => compact.includes(part)) ||
        tokens.some((t) => GENERIC_FINANCIAL_TOKENS.includes(t))));
  if (!financial) return false;
  // A quote, a balance or a list of rates moves nothing: only the tool's own words say so.
  const ownWords = withoutReadNouns(ownRaw);
  const verb = ownWords[0];
  const reads =
    verb !== undefined &&
    READ_VERBS.has(verb) &&
    !(GENERIC_READS.has(verb) && ownWords.length === 1) &&
    !ownWords.some((w) => ACTION_WORDS.has(w) || PASSTHROUGH_WORDS.has(w));
  return !reads;
}

/**
 * Whether a browser or computer-use action trades or moves money, from what the executor saw of
 * the control, the page's host and the app (`@psyche/protocol/financial-block`). A model is never
 * asked, and no approval changes it.
 */
export function isFinancialControl(call: PolicyCall): boolean {
  const c = call.meta?.control;
  const origin = call.target?.kind === "origin" ? call.target.value : undefined;
  const app = call.meta?.app ?? (call.target?.kind === "app" ? call.target.value : undefined);
  if (c === undefined && origin === undefined && app === undefined) return false;
  return (
    financialBlock({
      labels: c?.labels,
      alsoLabels: c?.alsoLabels,
      role: c?.role,
      submits: c?.submits,
      href: c?.href,
      formMethod: c?.formMethod,
      formAction: c?.formAction,
      pageUrl: c?.pageUrl,
      pageTitle: c?.pageTitle,
      unreadable: c?.unreadable,
      app,
      origin,
    }) !== undefined
  );
}
const PERMANENT_DELETE_TOOL =
  /(^|[._])(purge|expunge|empty_trash|delete_permanently|permanent_delete|permanently_delete|hard_delete|destroy|wipe|shred)([._]|$)/i;
const ACCOUNT_CREATION_TOOL =
  /(^|[._])(signup|sign_up|register|create_account|account_create)([._]|$)/i;
const CAPTCHA = /captcha|recaptcha|hcaptcha|turnstile|arkose|funcaptcha/i;
const CONTROL_PLANE_TOOL =
  /^(settings|config|grants|approvals|devices|device|pairing|policy|permissions|vault|security|gateway)[._]/i;
/** The helper's metadata reads for the people graph (#763): only its ingest path may call them. */
const GRAPH_INGEST_TOOL = /^(node\.)?messages\.graph_/i;
/** Vision OCR reads file contents for search ingest only (roadmap R6/R7). */
const OCR_INGEST_TOOL = /^(node\.)?ocr\./i;
/** Apple's on-device model runs for the model router only; an agent gets no raw line to it. */
const LLM_ROUTER_TOOL = /^(node\.)?llm\.apple\./i;
const PERMANENT_RM = new Set(["rm", "rmdir", "shred", "srm", "unlink"]);
/** cmd.exe's deleting commands and Sysinternals' sdelete (Windows). */
const WINDOWS_RM = new Set(["del", "erase", "rd", "rmdir", "sdelete", "sdelete64"]);
const WINDOWS_SHELLS = new Set(["cmd", "powershell", "pwsh"]);
const WINDOWS_SHELL_RM =
  /(^|[\s&|;(])(del|erase|rd|rmdir|rm|ri|remove-item|unlink|sdelete|sdelete64)(\.exe)?(\s|$)/i;
export const CONFIRMATION_WORD = "DELETE";

/** Paths Safari, Passwords and the keychain keep credentials in (macos notes, KQ7). */
const SYSTEM_CREDENTIAL_PATHS = [
  /^\/Users\/[^/]+\/Library\/Keychains(\/|$)/i,
  /^\/Library\/Keychains(\/|$)/i,
  /^\/Users\/[^/]+\/Library\/Safari(\/|$)/i,
  /^\/Users\/[^/]+\/Library\/Containers\/com\.apple\.Safari(\/|$)/i,
  /^\/Users\/[^/]+\/Library\/Cookies(\/|$)/i,
  /^\/Users\/[^/]+\/Library\/Application Support\/com\.apple\.Passwords/i,
  /^\/Users\/[^/]+\/Library\/Group Containers\/[^/]*com\.apple\.Passwords/i,
  /^\/private\/var\/db\/SystemKey/i,
  // CLI credentials and browser profiles in any home (security §5.3; #285).
  new RegExp(
    `^(/users/[^/]+|/home/[^/]+|/root)/(${[
      "\\.ssh",
      "\\.aws",
      "\\.gnupg",
      "\\.netrc",
      "\\.git-credentials",
      "\\.npmrc",
      "\\.pypirc",
      "\\.docker",
      "\\.kube",
      "\\.config/gh",
      "\\.config/gcloud",
      "\\.config/glab-cli",
      "\\.config/op",
      "\\.op",
      "\\.azure",
      "\\.config/doctl",
      "\\.config/hub",
      "library/application support/glab-cli",
      "library/application support/doctl",
      "\\.config/google-chrome",
      "\\.config/chromium",
      "\\.mozilla",
      "library/application support/google/chrome",
      "library/application support/firefox",
      "library/application support/arc",
      "library/application support/bravesoftware",
      // The desktop app's own user-data folder: its device key and the kept-recording signing key.
      "library/application support/psyche",
    ].join("|")})(/|$)`,
    "i",
  ),
  // Windows (paths compared as `c:/users/o/…`): the same CLI credentials in the profile, the
  // browsers' user data, Credential Manager and DPAPI keys, the desktop app's user data
  // (`%APPDATA%\Psyche`), the registry hive and the SAM.
  new RegExp(
    `^[a-z]:/users/[^/]+/(${[
      "\\.ssh",
      "\\.aws",
      "\\.gnupg",
      "_netrc",
      "\\.netrc",
      "\\.git-credentials",
      "\\.npmrc",
      "\\.pypirc",
      "\\.docker",
      "\\.kube",
      "\\.config/gh",
      "\\.config/gcloud",
      "\\.config/glab-cli",
      "\\.config/op",
      "\\.op",
      "\\.azure",
      "\\.config/doctl",
      "\\.config/hub",
      "ntuser\\.dat",
      "appdata/local/google/chrome/user data",
      "appdata/local/microsoft/edge/user data",
      "appdata/local/bravesoftware",
      "appdata/local/chromium",
      "appdata/roaming/mozilla",
      "appdata/local/mozilla",
      "appdata/roaming/microsoft/credentials",
      "appdata/local/microsoft/credentials",
      "appdata/roaming/microsoft/protect",
      "appdata/roaming/microsoft/vault",
      "appdata/local/microsoft/vault",
      "appdata/roaming/github cli",
      "appdata/roaming/gcloud",
      "appdata/roaming/glab-cli",
      "appdata/roaming/doctl",
      "appdata/roaming/psyche",
    ].join("|")})(/|$)`,
    "i",
  ),
  /^[a-z]:\/windows\/system32\/config(\/|$)/i,
];

/**
 * `$PSYCHE_HOME` entries a tool may reach: the agent's workspace and the Library. Everything else
 * (vault, state, audit, run, security, browser profiles, backups, MCP and speech settings,
 * models, config) is Psyche's own and never a file target (#285).
 */
const HOME_TOOL_ROOTS = ["workspace", "library"];
/** Workspace paths only the `memory` tool or skill install review may change (security §8, §11). */
function protectedWorkspacePath(path: string, workspace: string): boolean {
  if (inside(path, posix.join(workspace, "skills"))) return true;
  const rel = posix.relative(workspace, path);
  return PROTECTED_MEMORY_FILES.some((f) => f.toLowerCase() === rel);
}

function targetUrl(call: PolicyCall): CanonicalUrl | "invalid" | undefined {
  if (call.target?.kind !== "origin") return undefined;
  try {
    return canonicalUrl(call.target.value);
  } catch (e) {
    if (e instanceof TargetError) return "invalid";
    throw e;
  }
}

/**
 * Normalized and lowercased: APFS and NTFS are case-insensitive, so `/Users/o/.PSYCHE` is
 * `.psyche`. A Windows path is compared with `/` (`c:/users/o/.psyche`), so one form serves the
 * checks below. `"invalid"` for a Windows path that names a file another way (a stream, a trailing
 * dot, a device or a short name), which no check could judge.
 */
function targetPath(call: PolicyCall): string | "invalid" | undefined {
  if (call.target?.kind !== "path") return undefined;
  return comparablePath(call.target.value);
}

function comparablePath(raw: string): string | "invalid" | undefined {
  if (raw.startsWith("/") && !raw.startsWith("//")) return posix.normalize(raw).toLowerCase();
  if (!isAbsoluteHostPath(raw)) return undefined;
  try {
    return slashHostPath(canonicalHostPath(raw)).toLowerCase();
  } catch {
    return "invalid";
  }
}

/** `child` is `root` or under it; both in `comparablePath` form. */
function inside(child: string, root: string): boolean {
  if (root === "/") return child.startsWith("/");
  return child === root || child.startsWith(root.endsWith("/") ? root : `${root}/`);
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
  // Messages metadata for the people graph never reaches a tool or an agent, whatever the policy.
  if (GRAPH_INGEST_TOOL.test(tool)) {
    return deny("graph_ingest_only", "Messages metadata is read only by the people graph's ingest");
  }
  if (OCR_INGEST_TOOL.test(tool)) {
    return deny("ocr_ingest_only", "Text recognition is run only by the search ingest");
  }
  if (LLM_ROUTER_TOOL.test(tool)) {
    return deny("llm_router_only", "Apple's on-device model is run only by the model router");
  }
  const path = targetPath(call);
  if (path === "invalid") {
    return deny("invalid_path", "the path names a file another way than its own name");
  }
  const home = env.psycheHome === undefined ? undefined : comparablePath(env.psycheHome);
  if (path !== undefined && home !== undefined && home !== "invalid") {
    if (inside(path, posix.join(home, "vault")))
      return deny("psyche_state", "the vault is not a file target");
    if (inside(path, posix.join(home, "state", "teach")))
      return deny("teach_recordings", "kept demonstration recordings are not a file target");
    if (inside(path, home) && !HOME_TOOL_ROOTS.some((r) => inside(path, posix.join(home, r)))) {
      return deny(
        "psyche_state",
        "Psyche's own state, audit, settings and browser profiles are not file targets",
      );
    }
    const workspace = posix.join(home, "workspace");
    if (
      writePlus &&
      tool !== "memory" &&
      inside(path, workspace) &&
      protectedWorkspacePath(path, workspace)
    ) {
      return deny(
        "protected_workspace",
        "MEMORY.md, USER.md, AGENTS.md, SOUL.md, IDENTITY.md and skills change only through memory or skill review",
      );
    }
  }
  if (path !== undefined && SYSTEM_CREDENTIAL_PATHS.some((re) => re.test(path))) {
    return deny(
      "system_credentials",
      "keychains, browser profiles, SSH keys and CLI credentials are never read. To use a secret from one of them, store it in the vault and Psyche will fill it without seeing it",
    );
  }

  if (params.some((s) => s.tooDeep === true)) {
    return deny(
      "arguments_too_deep",
      "arguments nested deeper than 32 levels are not inspected, so refused",
    );
  }

  // A model-visible secret is never used, even one the owner pasted.
  for (const s of params) {
    const hit = findSensitive(s.value).find((m) =>
      ["private_key", "api_key", "bearer_token", "jwt", "url_credentials"].includes(m.kind),
    );
    if (hit !== undefined) {
      return deny(
        "visible_secret",
        `a ${hit.kind} is visible in the arguments; store it in the vault and Psyche will fill it without seeing it`,
      );
    }
  }

  // Placeholders resolve only in fill-capable executors (security §4.5).
  const fillTool = /^credentials\./.test(tool);
  for (const s of params) {
    if (!PLACEHOLDER_PATTERN.test(s.value)) continue;
    const execEnv =
      (effectiveKind === "exec" || effectiveKind === "exec_host") && s.path.startsWith("$.env.");
    // The browser's fill executor (§4.6): only its `placeholder` argument, and only a bare
    // placeholder there. The executor checks origin, element and approval before resolving.
    const browserFill =
      tool === "browser.fill_credential" &&
      s.path === "$.placeholder" &&
      /^\{\{cred:[a-z0-9][a-z0-9-]{0,63}(\.[a-z]+)?\}\}$/.test(s.value.trim());
    if (!fillTool && !execEnv && !browserFill) {
      return deny(
        "placeholder_outside_fill",
        "credential placeholders are only resolved by credentials.request",
      );
    }
  }

  // Passwords are typed by the owner or filled from the vault, never typed by the model.
  const field = meta.field;
  const passwordField =
    field?.secure === true ||
    field?.type?.toLowerCase() === "password" ||
    /password/i.test(field?.autocomplete ?? "");
  if (TYPING_TOOL.test(tool) && passwordField) {
    return deny(
      "password_typing",
      "the agent never types into a password field. Store the password in the vault and Psyche will fill it without seeing it",
    );
  }

  // Credential fills only into a matching field class (S23 design-01).
  if (effectiveKind === "credential_fill") {
    const mismatch = fillFieldMismatch(call.binding);
    if (mismatch !== undefined) return deny("fill_field_mismatch", mismatch);
  }

  // CAPTCHA: never solved, bypassed or outsourced.
  if (
    meta.captcha === true ||
    CAPTCHA.test(tool) ||
    params.some((s) => s.path.includes("<key>") && CAPTCHA.test(s.value))
  ) {
    return deny("captcha", "CAPTCHAs are never solved or bypassed");
  }
  if (field !== undefined && CAPTCHA.test(`${field.name ?? ""} ${field.role ?? ""}`)) {
    return deny("captcha", "CAPTCHAs are never solved or bypassed");
  }

  // Financial transfers and trades.
  if (isFinancialTransfer(tool) || isFinancialControl(call)) {
    return deny("financial_transfer", FINANCIAL_BLOCK_REASON);
  }

  // Loopback origins that are not the owner's own project (§3.10, design-03).
  const url = targetUrl(call);
  if (url === "invalid")
    return deny(
      "invalid_target",
      "the target URL is not canonical (userinfo, opaque or malformed)",
    );
  let loopbackOwned = false;
  if (url !== undefined) {
    const loopbackLike = isLoopbackName(url.host);
    const port = url.port ?? (url.scheme === "https" ? 443 : 80);
    const gatewayPorts = env.gatewayOrigins.flatMap((o) => {
      try {
        const g = canonicalUrl(o);
        return [g.port ?? (g.scheme === "https" ? 443 : 80)];
      } catch {
        return [];
      }
    });
    if (env.gatewayOrigins.includes(url.origin) || (loopbackLike && gatewayPorts.includes(port))) {
      return deny("gateway_origin", "the agent never acts on the Psyche Gateway's own UI");
    }
    if (loopbackLike) {
      const check = await env.localProject.check(url);
      if (!check.ok)
        return deny(
          "loopback_not_owned",
          `loopback origin is not the owner's project (${check.reason})`,
        );
      loopbackOwned = true;
    }
  }
  if (meta.testCredential === true && !loopbackOwned) {
    return deny(
      "test_credential_scope",
      "test credentials are only used on the owner's own local project",
    );
  }

  // Card numbers, bank accounts and government identifiers are never entered.
  if (writePlus || TYPING_TOOL.test(tool)) {
    for (const s of params) {
      for (const m of findSensitive(s.value)) {
        if (m.kind === "card_number") {
          const digits = cardDigits(s.value.slice(m.index, m.index + m.length));
          if (digits !== undefined && isPublishedTestCard(digits) && loopbackOwned) continue;
          return deny(
            "card_entry",
            "card numbers are never entered; purchases go through Link. Any other secret goes in the vault, and Psyche will fill it without seeing it",
          );
        }
        if (m.kind === "iban")
          return deny("bank_account_entry", "bank account numbers are never entered");
        if (m.kind === "us_ssn")
          return deny("government_id_entry", "government identifiers are never entered");
      }
    }
  }

  // What Psyche sends to another person or service goes through the one outbound check (security
  // §3.9), the same function the channel service uses. The audience is another party: a tool call
  // has no owner chat. Credentials, cards and their codes, IBANs and US Social Security numbers found
  // by the strict reading are refused outright; the other kinds (one-time codes, passports, SIN, NI and Aadhaar numbers, a
  // routing and account number) ask on a paired device, once, so the owner can still send their own
  // accountant a routing number (owner decision, review round 2).
  let outboundAsk: ProhibitionResult | undefined;
  if ((SEND_KINDS as readonly string[]).includes(effectiveKind)) {
    const asked = new Set<string>();
    for (const s of params) {
      const decision = outboundSendDecision(s.value);
      if (decision.action === "deny") {
        return deny(
          "outbound_sensitive",
          `the message holds ${decision.kinds.join(", ").replaceAll("_", " ")}; the owner sends such values themselves`,
        );
      }
      if (decision.action === "ask") for (const k of decision.kinds) asked.add(k);
    }
    if (asked.size > 0) {
      outboundAsk = {
        effect: "ask",
        id: "prohibition:outbound_identifier",
        reason: `the message holds ${[...asked].join(", ").replaceAll("_", " ")}; approve on a paired device`,
        deviceOnly: true,
      };
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
    return deny(
      "untrusted_memory_promotion",
      "a tainted turn cannot write USER.md / MEMORY.md / SOUL.md / AGENTS.md",
    );
  }

  // Permanent deletion needs the owner's typed confirmation word.
  if (
    meta.permanentDelete === true ||
    PERMANENT_DELETE_TOOL.test(tool) ||
    permanentRm(call, effectiveKind)
  ) {
    const claims = params.some((s) =>
      /(^|\.)(confirmation|typedConfirmation|confirm)$/.test(s.path),
    );
    if (claims)
      return deny(
        "self_confirmed_delete",
        "the confirmation word must come from the owner, not the call",
      );
    return {
      effect: "confirm",
      id: "prohibition:permanent_delete",
      reason: `permanent deletion needs the owner to type ${CONFIRMATION_WORD}`,
      word: CONFIRMATION_WORD,
    };
  }

  // Third-party account creation always asks.
  if (meta.accountCreation === true || ACCOUNT_CREATION_TOOL.test(tool)) {
    return {
      effect: "ask",
      id: "prohibition:account_creation",
      reason: "creating a third-party account needs approval",
    };
  }
  return outboundAsk;
}

function execEnv(call: PolicyCall): Record<string, string> | undefined {
  const fromBinding = (call.binding as { env?: Record<string, string> } | undefined)?.env;
  const fromParams = (call.params as { env?: Record<string, string> } | undefined)?.env;
  const env = fromBinding ?? fromParams;
  return typeof env === "object" && env !== null ? env : undefined;
}

function permanentRm(call: PolicyCall, kind: string): boolean {
  if (kind !== "exec_host") return false;
  const argv =
    (call.binding as { argv?: unknown } | undefined)?.argv ??
    (call.params as { argv?: unknown })?.argv;
  if (!Array.isArray(argv) || typeof argv[0] !== "string") return false;
  if (process.platform !== "win32") return PERMANENT_RM.has(posix.basename(argv[0]));
  // Windows: either separator, any case, `.exe` optional (`C:\Program Files\Git\usr\bin\RM.EXE`),
  // and the shells' deleting commands (`cmd /c del …`, `powershell -c Remove-Item …`).
  const name = (argv[0].split(/[\\/]/).at(-1) ?? "").toLowerCase().replace(/\.(exe|com)$/, "");
  if (PERMANENT_RM.has(name) || WINDOWS_RM.has(name)) return true;
  if (!WINDOWS_SHELLS.has(name)) return false;
  return argv.slice(1).some((a) => typeof a === "string" && WINDOWS_SHELL_RM.test(a));
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
      return t === "password"
        ? undefined
        : `password fields fill only input[type=password], not ${t || "unknown"}`;
    case "username":
      return ["text", "email", "tel"].includes(t)
        ? undefined
        : `usernames fill only text/email inputs, not ${t || "unknown"}`;
    case "totp":
      return ["text", "number", "tel", "password"].includes(t)
        ? undefined
        : `one-time codes fill only short inputs, not ${t || "unknown"}`;
    case "token":
      return ["text", "password"].includes(t)
        ? undefined
        : `tokens fill only text/password inputs, not ${t || "unknown"}`;
    default:
      return undefined;
  }
}
