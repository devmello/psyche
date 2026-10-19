import type { CatalogueEntry, ConnectorFactory } from "../framework/types.ts";
import { type ApproveMailCredential, MAIL_ACTIONS, MAIL_SCOPES, mailFactory } from "./connector.ts";
import { JmapBackend } from "./jmap/client.ts";

/** Fastmail and other JMAP servers: an API token (`{{cred:slug}}`) and the session URL. */
export const JMAP_CATALOGUE: CatalogueEntry = {
  type: "jmap",
  id: "jmap",
  label: "Fastmail (JMAP)",
  description: "Mail through JMAP with an API token; Fastmail by default.",
  category: "first_party",
  vendor: "Fastmail",
  auth: "token",
  scopes: MAIL_SCOPES,
  actions: MAIL_ACTIONS,
  setupGuide: "packages/connectors/README.md#other-mail-imap-smtp-and-jmap-m7",
  docsUrl: "https://www.fastmail.com/dev/",
  available: true,
};

export interface MailFactoryOptions {
  approveCredential?: ApproveMailCredential;
}

export function jmapFactory(options: MailFactoryOptions = {}): ConnectorFactory {
  return mailFactory({
    entry: JMAP_CATALOGUE,
    credentialKey: "token",
    backend: (config, ctx) => new JmapBackend(config, ctx.fetch),
    ...(options.approveCredential === undefined
      ? {}
      : { approveCredential: options.approveCredential }),
  });
}
