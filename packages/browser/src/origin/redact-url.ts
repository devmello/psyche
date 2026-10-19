/**
 * Mask credential-like query and fragment parameters before a URL reaches the model (review
 * finding 6c): OAuth codes and tokens, signatures, session ids. Origin and path stay readable;
 * the driver keeps the real URL internally.
 */
const SENSITIVE =
  /^(code|state|token|access_token|id_token|refresh_token|auth|authorization|password|passwd|pwd|pass|secret|client_secret|api[_-]?key|apikey|key|sig|signature|x-amz-signature|x-goog-signature|session|sessionid|session_id|sid|otp|ticket|jwt|samlresponse|samlrequest|assertion|nonce)$/i;

const MASK = "•••";

function maskParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const key of [...new Set(params.keys())]) {
    if (SENSITIVE.test(key)) {
      params.set(key, MASK);
      changed = true;
    }
  }
  return changed;
}

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
  let changed = false;
  if (url.username !== "" || url.password !== "") {
    url.username = "";
    url.password = "";
    changed = true;
  }
  const q = new URLSearchParams(url.search);
  if (maskParams(q)) {
    url.search = q.toString();
    changed = true;
  }
  if (url.hash.includes("=")) {
    const h = new URLSearchParams(url.hash.slice(1));
    if (maskParams(h)) {
      url.hash = h.toString();
      changed = true;
    }
  }
  return changed ? decodeURIComponent(url.href).replace(/%E2%80%A2/g, "•") : raw;
}

/** Redact every `url` string field in a tool output (recursively, plain data only). */
export function redactUrlsIn<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactUrlsIn(v)) as T;
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        (k === "url" || k === "href") && typeof v === "string" ? redactUrl(v) : redactUrlsIn(v);
    }
    return out as T;
  }
  return value;
}
