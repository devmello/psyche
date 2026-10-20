export {
  EMAIL_MAX_MESSAGE_CHARS,
  EmailAdapter,
  type EmailAdapterOptions,
  type EmailCursorStore,
  type EmailReply,
  type EmailSendAuthorizer,
  type EmailSendIntent,
  type EmailTransport,
  MemoryEmailCursorStore,
} from "./adapter.ts";
export {
  type EmailAttachmentInfo,
  type EmailInbound,
  mapEmail,
  replySubject,
  splitQuoted,
  threadKey,
} from "./mapping.ts";
