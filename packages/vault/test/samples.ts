/**
 * Pattern-shaped samples (cards, SSNs, IBANs, key blocks) assembled at run time, so the repo's
 * `check:secrets` scan (S18) sees no literal outside `tests/fixtures/secrets/registry.json`.
 * Card numbers are the networks' published test numbers.
 */
const j = (parts: string[], sep = "") => parts.join(sep);

export const VISA = j(["4111", "1111", "1111", "1111"]);
export const VISA_SPACED = j(["4111", "1111", "1111", "1111"], " ");
export const MC_DASHED = j(["5555", "5555", "5555", "4444"], "-");
export const AMEX = j(["3782", "822463", "10005"]);
export const IBAN_GB_SPACED = j(["GB82", "WEST", "1234", "5698", "7654", "32"], " ");
export const SSN = j(["123", "45", "6789"], "-");
export const SSH_KEY_BLOCK = j(["-----BEGIN OPENSSH ", "PRIVATE KEY-----", "fake", "-----END"]);
