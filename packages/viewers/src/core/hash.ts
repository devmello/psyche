/** `sha256:<hex>` of some bytes (WebCrypto; works in Node 20+ and browsers). */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes.slice());
  let hex = "";
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}
