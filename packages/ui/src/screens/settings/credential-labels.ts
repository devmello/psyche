import type { CredentialBinding, CredentialKind } from "@psyche/protocol";

/** Words shared by the Credentials section, its item detail and its import form. */

export const KIND_LABEL: Record<CredentialKind, string> = {
  login: "login",
  api_key: "API key",
  oauth_token: "OAuth token",
  ssh_key: "SSH key",
  note: "secure note",
  payment_link: "payment",
  signing_key: "signing key",
};

export const CARD_REFUSAL =
  "Psyche refuses raw card numbers, CVVs, bank account numbers and government IDs. For payments, add a payment link such as a Link wallet; the card stays with the provider.";

export function bindingLabel(b: CredentialBinding): string {
  if ("origin" in b) return b.origin.replace(/^https?:\/\//, "");
  if ("host" in b) return b.host;
  return b.connector === "stripe_link" ? "Link wallet" : b.connector;
}
