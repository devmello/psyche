import type { CatalogueEntry, ConnectorFactory } from "../framework/types.ts";
import { type ApproveMailCredential, MAIL_ACTIONS, MAIL_SCOPES, mailFactory } from "./connector.ts";
import { ImapBackend, type ImapBackendOptions } from "./imap/backend.ts";
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

/** Any mailbox with an app password: IMAPS for reading and filing, SMTPS for sending. */
export const IMAP_CATALOGUE: CatalogueEntry = {
  type: "imap",
  id: "imap",
  label: "Other mail (IMAP)",
  description: "Any mailbox with an app password: IMAP over TLS to read, SMTP over TLS to send.",
  category: "first_party",
  vendor: "IMAP / SMTP",
  auth: "app_password",
  scopes: MAIL_SCOPES,
  actions: MAIL_ACTIONS,
  setupGuide: "packages/connectors/README.md#other-mail-imap-smtp-and-jmap-m7",
  available: true,
};

export function imapFactory(
  options: MailFactoryOptions & ImapBackendOptions = {},
): ConnectorFactory {
  return mailFactory({
    entry: IMAP_CATALOGUE,
    credentialKey: "password",
    backend: (config) =>
      new ImapBackend(config, options.dial === undefined ? {} : { dial: options.dial }),
    ...(options.approveCredential === undefined
      ? {}
      : { approveCredential: options.approveCredential }),
  });
}
