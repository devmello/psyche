import type { ApprovalRequest } from "@psyche/protocol";
import { bindingHash } from "../canonical.ts";
import { FIXTURE_IDS } from "./threads.ts";

const BODY_HASH = `sha256:${"ab".repeat(32)}`;
const ATTACHMENT_HASH = `sha256:${"cd".repeat(32)}`;

/** The `send_email` request from data model §4.1, with a real binding hash. */
export const SAMPLE_APPROVAL_REQUEST: ApprovalRequest = {
  id: FIXTURE_IDS.approval,
  kind: "send_email",
  summary: 'Send reply to alice@example.com — "Re: Permission slip"',
  details: {
    account: "gmail:pat@example.com",
    to: ["alice@example.com"],
    cc: [],
    subject: "Re: Permission slip",
    bodyPreview: "Hi Alice, attached is the signed…",
    attachments: [{ name: "slip-filled.pdf", sha256: ATTACHMENT_HASH }],
  },
  bindingHash: bindingHash("send_email", {
    account: "gmail:pat@example.com",
    to: ["alice@example.com"],
    cc: [],
    bcc: [],
    subject: "Re: Permission slip",
    bodyHash: BODY_HASH,
    attachments: [`${ATTACHMENT_HASH}:1734:slip-filled.pdf`],
  }),
  grantKey: "email.send|gmail:pat@example.com|example.com",
  requestedBy: {
    runId: FIXTURE_IDS.run,
    taskId: FIXTURE_IDS.task,
    threadId: FIXTURE_IDS.thread,
    toolCallId: FIXTURE_IDS.toolCall,
    agent: "Pip",
  },
  sideEffect: "destructive",
  targetKind: "recipient",
  target: { kind: "recipient", value: "alice@example.com" },
  surfaces: ["desktop", "notification"],
  scopesOffered: ["once", "task"],
  deviceOnly: true,
  requiresAuthentication: false,
  taint: true,
  status: "pending",
  scopeGranted: null,
  decidedBy: null,
  requestedAt: "2026-10-18T20:11:05Z",
  expiresAt: "2026-10-18T20:41:05Z",
  decidedAt: null,
  grantId: null,
};
