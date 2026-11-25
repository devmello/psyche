import { redactSensitive } from "@psyche/audit";
import type { SecretRedactor } from "@psyche/vault";

/**
 * The redaction the promise lane uses before any text reaches a model (design 3.3,
 * `psyche-permissions` 3f): the vault's `SecretRedactor` for the owner's own secrets, then the
 * audit pass for what has a recognisable shape (cards, SSNs and other ids, keys, one-time codes,
 * recovery phrases). `{}` is the reading for text a model will read, so identifier-shaped tokens
 * are masked too. The lane redacts first, then trims, then cuts, so nothing here sees a cut value.
 */
export function promiseRedactor(secrets: Pick<SecretRedactor, "redact">): (text: string) => string {
  return (text) => redactSensitive(secrets.redact(text), {});
}
