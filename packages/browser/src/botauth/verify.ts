import { createPublicKey, verify } from "node:crypto";
import { signatureBase } from "./signer.ts";

/**
 * A minimal Web Bot Auth verifier, the way a site checks Psyche's signatures: parse
 * `Signature-Input`, rebuild the RFC 9421 signature base for `@authority` and `signature-agent`,
 * check the Ed25519 signature against the directory's key and the time window. Used by the
 * fixture origin in tests; the Gateway does not verify anyone.
 */
export type BotAuthVerdict =
  | { ok: true; keyId: string; nonce: string; signatureAgent: string }
  | { ok: false; reason: string };

export function verifyBotAuth(
  headers: Record<string, string>,
  authority: string,
  directory: { keys: { kty: string; crv: string; x: string }[] },
  nowSeconds = Math.floor(Date.now() / 1000),
): BotAuthVerdict {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const input = h["signature-input"];
  const sig = h.signature;
  const agent = h["signature-agent"];
  if (input === undefined || sig === undefined || agent === undefined) {
    return { ok: false, reason: "unsigned" };
  }
  const m = /^sig1=(\("@authority" "signature-agent"\);.*)$/.exec(input);
  if (m?.[1] === undefined) return { ok: false, reason: "bad_signature_input" };
  const params = m[1];
  const field = (name: string) => new RegExp(`;${name}=("([^"]*)"|(\\d+))`).exec(params);
  const created = Number(field("created")?.[3]);
  const expires = Number(field("expires")?.[3]);
  const keyId = field("keyid")?.[2];
  const nonce = field("nonce")?.[2];
  const tag = field("tag")?.[2];
  if (tag !== "web-bot-auth") return { ok: false, reason: "wrong_tag" };
  if (!(created <= nowSeconds + 5 && nowSeconds <= expires))
    return { ok: false, reason: "expired" };
  if (keyId === undefined || nonce === undefined)
    return { ok: false, reason: "bad_signature_input" };
  const sm = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(sig);
  if (sm?.[1] === undefined) return { ok: false, reason: "bad_signature" };
  const base = new TextEncoder().encode(signatureBase(authority, agent, params));
  for (const jwk of directory.keys) {
    const key = createPublicKey({ key: { ...jwk }, format: "jwk" });
    if (verify(null, base, key, Buffer.from(sm[1], "base64"))) {
      return { ok: true, keyId, nonce, signatureAgent: agent };
    }
  }
  return { ok: false, reason: "bad_signature" };
}
