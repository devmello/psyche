import { createHash, randomBytes } from "node:crypto";
import {
  type EmailInbound,
  type EmailReply,
  type EmailTransport,
  type SecretSource,
  staticSecret,
} from "@psyche/channels";
import {
  buildMime,
  decodeBase64Url,
  ImapBackend,
  type MailBackend,
  type MailSession,
} from "@psyche/connectors";
import { bindingFor } from "@psyche/permissions";
import { type JsonObject, PsycheError, ResolvedSecret } from "@psyche/protocol";
import type { ComposeServices } from "./services.ts";

/**
 * Email as a channel (N9) over the mail connector's IMAP + SMTP backend (S09): the transport the
 * `EmailAdapter` polls and replies through. Sessions open per poll or send and close at once; the
 * app password is used only inside `ResolvedSecret.use`. Every reply is re-verified against its
 * `message_send` approval right before SMTP (security §3.5, §3.7 "Dispatch") and leaves a receipt.
 */

export interface EmailSetup {
  /** The mailbox address Psyche reads and answers from: the channel's `account`. */
  address: string;
  /** IMAP connector config (`host`, `username`, optional `port`, `smtpHost`, `smtpPort`). */
  imap: Record<string, unknown>;
  /** The app password. */
  password: SecretSource;
  /** Poll interval (default 60 s). */
  pollMs?: number;
  /** Replaces the IMAP backend (tests: the connector's fake servers or a stub). */
  backend?: MailBackend;
}

/** `PSYCHE_EMAIL_*` → setup; off unless the address, IMAP host and password are all set. */
export function emailSetupFromEnv(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string,
): EmailSetup | undefined {
  const address = env.PSYCHE_EMAIL_ADDRESS?.trim().toLowerCase() ?? "";
  const host = env.PSYCHE_EMAIL_IMAP_HOST?.trim() ?? "";
  const file = env.PSYCHE_EMAIL_PASSWORD_FILE;
  const password = (file ? readFile(file) : (env.PSYCHE_EMAIL_PASSWORD ?? "")).trim();
  const given = [address, host, password].filter((v) => v !== "").length;
  if (given === 0) return undefined;
  if (given < 3) {
    throw new PsycheError(
      "invalid_params",
      "the email channel needs PSYCHE_EMAIL_ADDRESS, PSYCHE_EMAIL_IMAP_HOST and PSYCHE_EMAIL_PASSWORD(_FILE)",
    );
  }
  const smtpHost = env.PSYCHE_EMAIL_SMTP_HOST?.trim();
  return {
    address,
    imap: {
      host,
      username: env.PSYCHE_EMAIL_USERNAME?.trim() || address,
      account: address,
      ...(smtpHost ? { smtpHost } : {}),
    },
    password: staticSecret(password),
  };
}

export function mailEmailTransport(services: ComposeServices, setup: EmailSetup): EmailTransport {
  const backend = setup.backend ?? new ImapBackend(setup.imap);
  const account = setup.address;
  const withSession = <T>(fn: (s: MailSession) => Promise<T>): Promise<T> =>
    setup.password.use(async (value) => {
      const secret = new ResolvedSecret(value, {
        credentialId: "channel-email",
        target: { kind: "account", value: account },
      });
      const session = await backend.open(secret);
      try {
        return await fn(session);
      } finally {
        await session.close().catch(() => undefined);
      }
    });
  const domain = account.split("@")[1] ?? "psyche.invalid";

  return {
    async poll(cursor) {
      return withSession(async (s) => {
        const r = await s.sync(cursor);
        const messages: EmailInbound[] = [];
        for (const id of r.newMessageIds.slice(0, 50)) {
          const v = await s.read({ id });
          const from = bareAddress(v.from);
          if (from === undefined) continue;
          const name = /^\s*"?([^"<]+?)"?\s*</.exec(v.from)?.[1]?.trim();
          messages.push({
            id: v.id,
            messageId: v.messageId,
            from,
            ...(name === undefined || name === "" ? {} : { fromName: name }),
            subject: v.subject,
            date: Date.parse(v.date) || Date.now(),
            text: v.body,
            ...(v.inReplyTo === "" ? {} : { inReplyTo: v.inReplyTo }),
            references: v.references.split(/\s+/).filter((x) => x.startsWith("<")),
            attachments: v.attachments.map((a) => ({
              partId: a.partId,
              filename: a.filename,
              mimeType: a.mimeType,
              size: a.size,
            })),
          });
        }
        return { messages, cursor: r.cursor as JsonObject };
      });
    },

    async send(reply: EmailReply, approvalId: string) {
      const binding = bindingFor("message_send", {
        channel: "email",
        account,
        recipient: reply.thread,
        bodySha256: `sha256:${createHash("sha256").update(reply.text, "utf8").digest("hex")}`,
      });
      const verified = await services.rawBroker.verifyBinding(approvalId, binding.bindingHash);
      if (!verified.ok) {
        throw new PsycheError(
          verified.reason === "binding_mismatch" ? "binding_mismatch" : "approval_required",
          `approval ${approvalId} does not cover this reply (${verified.reason})`,
        );
      }
      const messageId = `<psyche.${randomBytes(12).toString("hex")}@${domain}>`;
      const mail = {
        from: account,
        to: [reply.to],
        subject: reply.subject,
        text: reply.text,
        inReplyTo: reply.inReplyTo,
        references: reply.references,
      };
      const body = decodeBase64Url(buildMime(mail));
      if (body === null) throw new PsycheError("internal", "could not build the reply");
      const head = `Message-ID: ${messageId}\r\nDate: ${new Date().toUTCString()}\r\nAuto-Submitted: auto-replied\r\n`;
      const raw = Buffer.concat([Buffer.from(head, "utf8"), Buffer.from(body)]);
      let outcome: "ok" | "failed" = "failed";
      try {
        await withSession((s) => s.send(mail, raw));
        outcome = "ok";
        return { messageId };
      } finally {
        await services.broker
          .recordReceipt({
            kind: "channel.email.send",
            outcome,
            summary: `Email reply to ${reply.to}`,
            approvalId,
          })
          .catch(() => undefined);
      }
    },

    async attachment(id, partId) {
      const file = await withSession((s) => s.attachment({ id, partId }));
      return file.bytes;
    },
  };
}

/** `Name <a@b.c>` or `a@b.c` → `a@b.c` (lower-case); undefined when it is not one address. */
export function bareAddress(value: string): string | undefined {
  const inner = /<([^<>\s]+)>\s*$/.exec(value)?.[1] ?? value.trim();
  const a = inner.toLowerCase();
  return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(a) ? a : undefined;
}
