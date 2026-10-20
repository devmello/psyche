import type { CredentialBinding, CredentialKind } from "@psyche/protocol";
import { t } from "../../i18n/core.ts";

/** Words shared by the Credentials section, its item detail and its import form. */

/** "login", "API key", …: a credential kind as a lower-case noun, in the active language. */
export const credentialKindLabel = (kind: CredentialKind): string =>
  t(`settings.credentials.kind.${kind}`);

/** Why Psyche refuses card numbers and the like, and what to add instead. */
export const cardRefusal = (): string => t("settings.credentials.cardRefusal");

export function bindingLabel(b: CredentialBinding): string {
  if ("origin" in b) return b.origin.replace(/^https?:\/\//, "");
  if ("host" in b) return b.host;
  return b.connector === "stripe_link" ? t("settings.credentials.linkWallet") : b.connector;
}
