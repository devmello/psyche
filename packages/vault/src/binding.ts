import type {
  CredentialBinding,
  CredentialExecutor,
  CredentialField,
  FillElement,
  Target,
} from "@psyche/protocol";
import { bindingHash, toolCallBindingHash } from "@psyche/protocol/binding";

/**
 * Origin of an http(s) URL (`scheme://host[:port]`, default ports dropped, host lowercased and
 * punycoded), or `null` for anything else. Opaque origins (`android://…`, `data:`, `file:`)
 * are never fillable (S23 design-13).
 */
export function canonicalOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.includes("*")) return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

/**
 * Loopback dev hosts (docs/05 §3.10): exactly `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`.
 * Not `*.test`: a name can resolve anywhere (S23 design-03); fills go to literal loopback only.
 */
export function isLoopbackDevHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]";
}

/**
 * An origin a credential may be filled into: https, or http on a loopback dev host (#292).
 * Plain http elsewhere would send the value in clear text to anyone on the path.
 */
export function isFillableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopbackDevHost(url.hostname);
}

/** Host (with port when not default) of a URL or a bare `host[:port]`. */
export function canonicalHost(value: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.host;
  } catch {
    return null;
  }
}

/**
 * Suffixes under which anyone can get a subdomain, so `https://*.<suffix>` would match an
 * attacker's site. Not the full Public Suffix List: wildcard bindings also need two labels
 * below the TLD's registrable part, and the UI shows the pattern on every fill card.
 */
const SHARED_SUFFIXES = new Set([
  "github.io",
  "gitlab.io",
  "pages.dev",
  "workers.dev",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "web.app",
  "firebaseapp.com",
  "appspot.com",
  "blogspot.com",
  "azurewebsites.net",
  "cloudfront.net",
  "s3.amazonaws.com",
  "amazonaws.com",
  "fly.dev",
  "onrender.com",
  "glitch.me",
  "repl.co",
  "ngrok.io",
  "ngrok-free.app",
  "trycloudflare.com",
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "co.nz",
  "com.br",
  "com.cn",
  "com.mx",
  "co.in",
  "co.za",
  "com.tr",
  "com.sg",
  "com.hk",
]);

function wildcardProblem(suffix: string): string | null {
  const host = canonicalHost(suffix);
  if (host === null || host.includes("*") || host.includes(":")) return "invalid subdomain pattern";
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => l.length === 0)) {
    return "a subdomain pattern needs a registrable domain";
  }
  if (SHARED_SUFFIXES.has(host)) {
    return "a subdomain pattern over a shared or public suffix matches anyone's site";
  }
  return null;
}

/** Validates a binding as entered (add / edit / import). Returns a reason when unusable. */
export function bindingProblem(b: CredentialBinding): string | null {
  if ("origin" in b) {
    const wildcard = /^https:\/\/\*\.([^/*]+)$/i.exec(b.origin);
    if (wildcard !== null) return wildcardProblem(wildcard[1] ?? "");
    if (b.origin.includes("*")) return "only https://*.domain patterns are allowed";
    const origin = canonicalOrigin(b.origin);
    if (origin === null) return "origin must be an http(s) origin";
    if (!isFillableOrigin(origin)) {
      return "credentials bind to https origins (plain http only for a localhost dev server)";
    }
    const url = new URL(b.origin);
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return "bind an origin, not a URL with a path";
    }
    return null;
  }
  if ("host" in b) return canonicalHost(b.host) === null ? "invalid host" : null;
  return b.connector.length > 0 ? null : "empty connector id";
}

/** Normalizes a binding for storage (`https://GitHub.com/` → `https://github.com`). */
export function normalizeBinding(b: CredentialBinding): CredentialBinding {
  if ("origin" in b) {
    if (b.origin.startsWith("https://*.")) return { origin: b.origin.toLowerCase() };
    return { origin: canonicalOrigin(b.origin) ?? b.origin };
  }
  if ("host" in b) return { host: canonicalHost(b.host) ?? b.host };
  return { connector: b.connector };
}

/**
 * True when `target` matches a binding exactly (security §4.5): same origin (scheme, host,
 * port), or a declared `https://*.example.com` pattern (subdomains only, https only), or the
 * same host for host bindings (https only), or the connector account.
 */
export function bindingMatches(bindings: CredentialBinding[], target: Target): boolean {
  return bindings.some((b) => {
    if ("connector" in b) return target.kind === "account" && target.value === b.connector;
    if (target.kind !== "origin") return false;
    if ("host" in b) {
      if (!target.value.startsWith("https://")) return false;
      const host = canonicalHost(target.value);
      return host !== null && host === canonicalHost(b.host);
    }
    const origin = canonicalOrigin(target.value);
    // An http binding stored before #292, or an http target, never matches outside loopback.
    if (origin === null || !isFillableOrigin(origin)) return false;
    const wildcard = /^https:\/\/\*\.([^/*]+)$/.exec(b.origin);
    if (wildcard !== null) {
      const suffix = canonicalHost(wildcard[1] ?? "");
      const host = new URL(origin).host;
      return origin.startsWith("https://") && suffix !== null && host.endsWith(`.${suffix}`);
    }
    return origin === canonicalOrigin(b.origin);
  });
}

/**
 * Strict canonical JSON for binding hashes: sorted keys, no whitespace, and only strings,
 * finite integers, booleans, null, arrays and plain objects. Anything else throws, so NaN,
 * Infinity, Maps and Dates cannot collide with `null` / `{}` (S23 design-13). Strings are hashed
 * as given (no Unicode folding: what is hashed is what is executed).
 */
export function strictCanonicalJSON(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError("canonicalJSON: non-integer number");
      return String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map(strictCanonicalJSON).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("canonicalJSON: only plain objects");
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${strictCanonicalJSON(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonicalJSON: unsupported ${typeof value}`);
  }
}

export interface CredentialFillBindingInput {
  itemId: string;
  /** Canonical origin (browser) or host / connector account (other executors). */
  target: string;
  field: CredentialField | "secret";
  executor: CredentialExecutor;
  /** Browser: approved `ref_N`. */
  selector?: string;
  /** Browser: the element's tag / type / autocomplete as approved. */
  element?: Pick<FillElement, "tagName" | "type" | "autocomplete">;
}

/**
 * Fields of the `credential_fill` binding hash (security §3.5: item id, origin, field selector
 * with element name / type, field). Data model §4.2 lists `tab id` instead of the field; the
 * security doc wins (S23 design-13, objection in docs/status/s06.md).
 */
export function credentialFillFields(input: CredentialFillBindingInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    executor: input.executor,
    field: input.field,
    itemId: input.itemId,
    target: input.target,
  };
  if (input.selector !== undefined) out.selector = input.selector;
  if (input.element !== undefined) {
    out.element = {
      autocomplete: input.element.autocomplete ?? "",
      tagName: input.element.tagName.toLowerCase(),
      type: (input.element.type ?? "").toLowerCase(),
    };
  }
  return out;
}

/**
 * The `credential_fill` binding, through the shared recipe (`@psyche/protocol/binding`). For a
 * fill the agent loop approved, the loop's envelope over the tool call with these fields; for a
 * request the vault built itself (`requestFill`), the bare fields.
 */
export function credentialFillBindingHash(
  input: CredentialFillBindingInput,
  call?: { tool: string; params: unknown },
): `sha256:${string}` {
  const fields = credentialFillFields(input);
  return call === undefined
    ? bindingHash("credential_fill", fields)
    : toolCallBindingHash(call.tool, call.params, {
        kind: "credential_fill",
        bindingFields: fields,
      });
}

/** Field class a `site` grant is bound to (S23 design-01: the grant key includes it). */
export function fieldClass(field: CredentialField | "secret", kind: string): string {
  if (field === "secret") return kind === "login" ? "password" : "token";
  return field;
}

/**
 * `credential_fill|<item>|<origin>|<field class>|<executor>`: what a `site` grant matches. The
 * executor is part of it, so a browser login grant never covers a sandbox or connector fill of
 * the same password.
 */
export function credentialFillGrantKey(input: CredentialFillBindingInput, kind: string): string {
  return `credential_fill|${input.itemId}|${input.target}|${fieldClass(input.field, kind)}|${input.executor}`;
}
