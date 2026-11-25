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
import { bindingFor, checkOutbound } from "@psyche/permissions";
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

/** Messages read per poll; the rest wait for the next one. */
export const EMAIL_POLL_BATCH = 50;

/**
 * The ids this poll reads and the cursor to save after them. When more than a batch arrived the
 * cursor stops right after the last id read (IMAP: `uidNext` = that uid + 1), so the rest come
 * back on the next poll instead of being passed over. Ids that are not numeric uids cannot be
 * resumed from, so those polls read everything.
 */
export function pollBatch(
  ids: string[],
  cursor: JsonObject,
): { batch: string[]; cursor: JsonObject } {
  if (ids.length <= EMAIL_POLL_BATCH) return { batch: ids, cursor };
  const uids = ids.map(Number);
  const inbox = cursor.inbox;
  if (
    !uids.every((u) => Number.isInteger(u) && u >= 0) ||
    inbox === null ||
    typeof inbox !== "object" ||
    Array.isArray(inbox)
  ) {
    return { batch: ids, cursor };
  }
  const order = ids
    .map((id, i) => ({ id, uid: uids[i] as number }))
    .sort((a, b) => a.uid - b.uid)
    .slice(0, EMAIL_POLL_BATCH);
  const last = order[order.length - 1]?.uid as number;
  return {
    batch: order.map((o) => o.id),
    cursor: { ...cursor, inbox: { ...inbox, uidNext: last + 1 } },
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
        const { batch, cursor: next } = pollBatch(r.newMessageIds, r.cursor as JsonObject);
        const messages: EmailInbound[] = [];
        let failed = 0;
        for (const id of batch) {
          let v: Awaited<ReturnType<MailSession["read"]>>;
          try {
            v = await s.read({ id });
          } catch (err) {
            // One unreadable message must not block the others (it is skipped, not retried
            // forever); if none could be read the session itself is the problem, so fail the
            // poll and keep the cursor where it was.
            failed += 1;
            services.logger?.log("warn", "email channel could not read a message; skipped", {
              code: PsycheError.from(err).code,
            });
            continue;
          }
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
        if (failed > 0 && failed === batch.length) {
          throw new PsycheError("unavailable", "the email channel could not read any new message", {
            retryable: true,
          });
        }
        return { messages, cursor: next };
      });
    },

    async send(reply: EmailReply, approvalId: string) {
      // Defence in depth: the channel service already held this, but the transport is the last stop
      // before the mail leaves, and a reply is always held, never redacted (security §3.9). The
      // subject is not checked: it is the sender's own subject line, not Psyche's text.
      if (checkOutbound(reply.text, "other").action !== "allow") {
        throw new PsycheError("forbidden", "the reply holds a credential or personal identifier");
      }
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
