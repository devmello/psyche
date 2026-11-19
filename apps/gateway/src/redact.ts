import { PsycheError } from "@psyche/protocol";

/**
 * Display redaction for tool-server configs and the text around them. Everything here is for
 * what leaves the Gateway to a client or an error message; the Gateway itself keeps starting
 * servers from the stored config.
 */

/** The marker left where a value was hidden. */
export const REDACTED = "***";

const PLACEHOLDER = /^\{\{cred:[^}]+\}\}$/;

/**
 * A name or path segment that carries a secret: nothing after it, an `sk-`/`ak-` prefix, or a
 * long run of mixed letters and digits.
 */
export function looksSecretName(s: string): boolean {
  if (/^(sk|ak)-/i.test(s)) return true;
  return s.length >= 16 && /^[A-Za-z0-9_\-.~%]+$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s);
}

/**
 * A URL as shown to the owner: no user info, no fragment, every query value hidden, query keys
 * with no value hidden (`?sk-SECRET`), and token-like path segments hidden. Unparseable input
 * shows nothing.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const path = u.pathname
      .split("/")
      .map((seg) => (seg !== "" && looksSecretName(seg) ? REDACTED : seg))
      .join("/");
    const parts: string[] = [];
    for (const [k, v] of u.searchParams.entries()) {
      const part =
        v === ""
          ? REDACTED
          : `${looksSecretName(k) ? REDACTED : encodeURIComponent(k)}=${REDACTED}`;
      if (!parts.includes(part)) parts.push(part);
    }
    return `${u.protocol}//${u.host}${path}${parts.length === 0 ? "" : `?${parts.join("&")}`}`;
  } catch {
    return "";
  }
}

/**
 * True when a submitted address still holds the display marker anywhere a value can hide (user
 * info, path, query key or value, fragment). A part that cannot be decoded counts as holding it:
 * fail closed.
 */
export function urlHoldsMarker(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw.includes(REDACTED);
  }
  // The query first: searchParams never throws.
  for (const [k, v] of u.searchParams.entries()) {
    if (k.includes(REDACTED) || v.includes(REDACTED)) return true;
  }
  for (const part of [u.username, u.password, u.pathname, u.hash, u.search]) {
    try {
      if (decodeURIComponent(part).includes(REDACTED)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** The parts of an address that are secrets, in the forms they may appear in other text. */
function secretsOf(raw: string): string[] {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const add = (v: string) => {
    // A short value (`true`, `json`) would blank ordinary words; it is still hidden inside any
    // address by the pass below.
    if (v.length < 8) return;
    found.add(v);
    found.add(encodeURIComponent(v));
    try {
      found.add(decodeURIComponent(v));
    } catch {
      // keep the raw form only
    }
  };
  add(u.username);
  add(u.password);
  for (const [k, v] of u.searchParams.entries()) {
    add(v);
    if (v === "" || looksSecretName(k)) add(k);
  }
  for (const seg of u.pathname.split("/")) if (seg !== "" && looksSecretName(seg)) add(seg);
  return [...found].filter((s) => s !== "");
}

const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Text from a probe or a host (it can quote an address): every address in it is redacted, and the
 * secrets of the `known` addresses (stored URLs) are hidden wherever they appear in the text.
 */
export function redactText(text: string, known: readonly string[] = []): string {
  let out = text;
  for (const raw of known) for (const s of secretsOf(raw)) out = out.split(s).join(REDACTED);
  return out.replace(/\b(?:https?|wss?):(?:\\?\/){2}[^\s"'<>]+/gi, (m) => {
    let core = m.replace(/\\\//g, "/");
    let tail = "";
    for (;;) {
      const last = core.slice(-1);
      const opener = OPENERS[last];
      const trim =
        /[.,;:!?]/.test(last) ||
        (opener !== undefined && core.split(last).length - 1 > core.split(opener).length - 1);
      if (!trim || core === "") break;
      tail = last + tail;
      core = core.slice(0, -1);
    }
    return `${redactUrl(core) || "[address]"}${tail}`;
  });
}

function scrub(value: unknown, known: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, known);
  if (Array.isArray(value)) return value.map((v) => scrub(v, known));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, known)]));
  }
  return value;
}

/** The same error with every address in its words and details redacted. */
export function scrubError(err: unknown, known: readonly string[] = []): PsycheError {
  const e = PsycheError.from(err);
  return new PsycheError(e.code, redactText(e.message, known), {
    details: scrub(e.details, known),
    retryable: e.retryable,
  });
}

/** A flag or variable name whose last word names a secret (`--api-key`, `--access-token`, `TOKEN`). */
const SECRET_WORD =
  /^(?:key|token|secret|password|passwd|credential|cookie|authorization|bearer|pat)$/i;
function secretName(name: string): boolean {
  const words = name
    .replace(/^-+/, "")
    .split(/[-_]+/)
    .filter((w) => w !== "");
  const last = words.at(-1);
  return last !== undefined && SECRET_WORD.test(last);
}
const TOKEN_PREFIX = /^(?:sk|ak)-|^ghp_|^gho_|^ghs_|^github_pat_|^xox[abprs]-/i;

/** A long run of mixed letters and digits, or a well-known token prefix. */
function tokenLikeArg(arg: string): boolean {
  if (TOKEN_PREFIX.test(arg)) return true;
  return (
    arg.length >= 20 && /^[A-Za-z0-9_\-.~%]+$/.test(arg) && /[A-Za-z]/.test(arg) && /\d/.test(arg)
  );
}

/**
 * A command line as a client may read it: the value of a flag that names a secret
 * (`--api-key=…`, `--token …`), a token-looking argument, and the secrets of an address argument
 * are hidden. The program and ordinary arguments stay.
 */
export function redactArgv(argv: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  let hideNext = false;
  for (const arg of argv) {
    if (typeof arg !== "string") {
      out.push(arg);
      continue;
    }
    if (hideNext) {
      out.push(REDACTED);
      hideNext = false;
      continue;
    }
    const eq = arg.indexOf("=");
    if (arg.startsWith("-")) {
      // A flag's value is hidden when the flag's name says secret, or when the value looks like one.
      if (eq > 0) {
        const value = arg.slice(eq + 1);
        if (secretName(arg.slice(0, eq)) || tokenLikeArg(value)) {
          out.push(`${arg.slice(0, eq + 1)}${REDACTED}`);
          continue;
        }
      } else if (secretName(arg)) {
        out.push(arg);
        hideNext = true;
        continue;
      }
    } else if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg.slice(0, eq))) {
      // A positional NAME=value (an environment-style argument).
      const value = arg.slice(eq + 1);
      if (secretName(arg.slice(0, eq)) || tokenLikeArg(value)) {
        out.push(`${arg.slice(0, eq + 1)}${REDACTED}`);
        continue;
      }
    }
    if (/^(?:https?|wss?):\/\//i.test(arg)) {
      out.push(redactUrl(arg) || REDACTED);
      continue;
    }
    out.push(tokenLikeArg(arg) ? REDACTED : arg);
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The `mcp.servers` setting as a client may read it: env values blank (a `{{cred:}}` placeholder
 * is only a reference and stays), URLs redacted, and every auth field but its kind removed.
 * Anything else that is not a plain entry is dropped. `mcp.config` and `mcp.secrets` are how the
 * owner sees a server's details.
 */
export function redactMcpServers(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value)) return [];
  return value.filter(isObj).map((entry) => {
    const { auth, headers: _headers, transport, ...rest } = entry;
    const out: Record<string, unknown> = { ...rest };
    if (isObj(auth)) out.auth = { kind: typeof auth.kind === "string" ? auth.kind : "none" };
    if (isObj(transport)) {
      const { env, url, headers: _h, command, ...t } = transport;
      const next: Record<string, unknown> = { ...t };
      if (Array.isArray(command)) next.command = redactArgv(command);
      if (typeof url === "string") next.url = redactUrl(url);
      if (isObj(env)) {
        next.env = Object.fromEntries(
          Object.entries(env).map(([k, v]) => [
            k,
            typeof v === "string" && PLACEHOLDER.test(v) ? v : "",
          ]),
        );
      }
      out.transport = next;
    }
    return out;
  });
}
