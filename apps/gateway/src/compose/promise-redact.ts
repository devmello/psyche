import { redactSensitive } from "@psyche/audit";
import { maskPointsShapes } from "@psyche/protocol/points-rules";
import type { SecretRedactor } from "@psyche/vault";

/**
 * The redaction the promise lane uses before any text reaches a model (design 3.3,
 * `psyche-permissions` 3f): the vault's `SecretRedactor` for the owner's own secrets, then the
 * audit pass for what has a recognisable shape (cards, SSNs and other ids, keys, one-time codes,
 * recovery phrases, and the Points rules' mask for a phrase written as plain words). `{}` is the reading for text a model will read, so identifier-shaped tokens
 * are masked too. The lane redacts first, then trims, then cuts, so nothing here sees a cut value.
 */
export function promiseRedactor(secrets: Pick<SecretRedactor, "redact">): (text: string) => string {
  // The last step masks a recovery phrase (twelve or more plain words in a row) and other shapes.
  return (text) => maskPointsShapes(redactSensitive(secrets.redact(text), {}));
}
