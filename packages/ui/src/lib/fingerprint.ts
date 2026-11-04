/**
 * A Gateway identity key's fingerprint (`sha256:<hex>`) as the owner compares it: the first 24 hex
 * characters in groups of four. The Host's pairing card and the new computer's screen both use it,
 * so the two read the same.
 */
export function groupFingerprint(fingerprint: string): string {
  const hex = fingerprint.replace(/^sha256:/, "").slice(0, 24);
  return (hex.match(/.{1,4}/g) ?? []).join(" ");
}

/** A certificate pin (SHA-256 of its SPKI, base64url) as a `sha256:<hex>` fingerprint to compare. */
export function pinFingerprint(pinB64url: string): string {
  const b64 = pinB64url.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bytes = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
    return `sha256:${[...bytes].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
  } catch {
    return pinB64url;
  }
}
