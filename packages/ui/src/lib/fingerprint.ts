/**
 * A Gateway identity key's fingerprint (`sha256:<hex>`) as the owner compares it: the first 24 hex
 * characters in groups of four. The Host's pairing card and the new computer's screen both use it,
 * so the two read the same.
 */
export function groupFingerprint(fingerprint: string): string {
  const hex = fingerprint.replace(/^sha256:/, "").slice(0, 24);
  return (hex.match(/.{1,4}/g) ?? []).join(" ");
}
