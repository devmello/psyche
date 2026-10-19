import type { ApprovalRequest, Grant } from "@psyche/protocol";
import { at, fakeSha, IDS, inMinutes, today } from "./ids.ts";

/**
 * Approval requests (pending and decided), this surface's answer tokens and the grants ledger.
 * `details` follow UI design §3.3 "Binding details shown in full, by kind". The Broker's reason
 * ("Why asked") has no wire field, so it travels as `details.reason`.
 */

const A = IDS.approvals;
const T = IDS.threads;
const R = IDS.runs;
const TC = IDS.toolCalls;

const SURFACES = ["desktop", "notification", "telegram:you"];

function approval(
  partial: Pick<
    ApprovalRequest,
    "id" | "kind" | "summary" | "details" | "grantKey" | "requestedBy" | "requestedAt" | "expiresAt"
  > &
    Partial<ApprovalRequest>,
): ApprovalRequest {
  return {
    bindingHash: fakeSha(`binding:${partial.id}`),
    surfaces: SURFACES,
    scopesOffered: ["once", "task", "always"],
    deviceOnly: false,
    requiresAuthentication: false,
    taint: false,
    status: "pending",
    scopeGranted: null,
    decidedBy: null,
    decidedAt: null,
    grantId: null,
    ...partial,
  };
}

const TAX_DIFF = `--- /dev/null
+++ ~/Documents/Taxes/letter-to-tax-office.md
@@ -0,0 +1,9 @@
+# Re: Notice CP-2026-118 (late filing)
+
+To whom it may concern,
+
+I filed my 2025 return on April 16, one day after the deadline, because the
+e-file service was down on April 15. The confirmation is attached.
+
+I request that the late-filing penalty of $86 be waived.
+Thank you for your time.`;

const WRITE_DIFF_STALE = `--- ~/Projects/psyche/README.md
+++ ~/Projects/psyche/README.md
@@ -1,3 +1,4 @@
 # Psyche
+An open-source personal agent.

 See docs/ for the design.`;

export function approvals(): ApprovalRequest[] {
  return [
    // --- Pending -------------------------------------------------------------------------------
    approval({
      id: A.sendEmail,
      kind: "send_email",
      summary: "Send an email to jane.ortiz@example.com",
      details: {
        account: "gmail:you@gmail.com",
        accountDisplay: "Gmail - you@gmail.com",
        to: ["jane.ortiz@example.com"],
        cc: [],
        bcc: [],
        subject: "Confirming Tuesday 2:30",
        bodyPreview:
          "Hi Jane,\n\nThanks for checking. Please confirm Tuesday, October 20 at 2:30 pm with Dr. Ortiz.\n\nBest,\nYou",
        bodyParagraphs: 3,
        bodyHash: fakeSha("body:confirming-tuesday"),
        attachments: [],
        reason: "balanced mode; write; turn read untrusted content",
      },
      grantKey: "email.send|gmail:you@gmail.com|example.com",
      requestedBy: {
        runId: R.dentistBook,
        taskId: IDS.tasks.dentist,
        threadId: T.dentist,
        toolCallId: TC.dentistSendConfirm,
        agent: "Wren",
      },
      sideEffect: "write",
      targetKind: "recipient",
      target: { kind: "recipient", value: "jane.ortiz@example.com" },
      taint: true,
      requestedAt: today("10:10", "41"),
      expiresAt: today("10:40", "41"),
    }),
    approval({
      id: A.credentialFill,
      kind: "credential_fill",
      summary: "Fill your acme.com login from the vault",
      details: {
        item: "acme-login",
        itemName: "acme.com login",
        credentialId: IDS.credentials.acme,
        boundOrigin: "https://acme.com",
        currentOrigin: "https://acme.com",
        fields: ["username", "password"],
        fieldSelector: "form#login",
        tabId: "tab_1",
        reason: "credential fills always ask; needs Touch ID",
      },
      grantKey: "credential.fill|acme-login|https://acme.com",
      requestedBy: {
        runId: R.dentistBook,
        taskId: IDS.tasks.dentist,
        threadId: T.dentist,
        toolCallId: TC.dentistCredential,
        agent: "Wren",
      },
      sideEffect: "write",
      targetKind: "origin",
      target: { kind: "origin", value: "https://acme.com", display: "acme.com" },
      surfaces: ["desktop", "notification"],
      scopesOffered: ["once", "site"],
      deviceOnly: true,
      requiresAuthentication: true,
      taint: true,
      requestedAt: today("10:11", "45"),
      expiresAt: at(45),
    }),
    approval({
      id: A.exec,
      kind: "exec",
      summary: "Run `npm install` in ~/Projects/psyche",
      details: {
        argv: ["npm", "install"],
        cwd: "~/Projects/psyche",
        cwdResolved: "/Users/you/Projects/psyche",
        env: ["PATH", "HOME", "NODE_ENV"],
        executable: "/opt/homebrew/bin/npm",
        executableHash: fakeSha("exe:npm"),
        sandboxId: IDS.sandbox,
        network: "registry.npmjs.org",
        reason: "balanced mode; exec always asks",
      },
      grantKey: "exec|npm install|/Users/you/Projects/psyche",
      requestedBy: {
        runId: R.main,
        taskId: null,
        threadId: T.main,
        toolCallId: TC.mainExec,
        agent: "Wren",
      },
      sideEffect: "write",
      targetKind: "command",
      target: { kind: "command", value: "npm install", display: "npm install" },
      requestedAt: today("09:41"),
      expiresAt: today("10:41"),
    }),
    approval({
      id: A.fileWrite,
      kind: "file_write",
      summary: "Write ~/Documents/Taxes/letter-to-tax-office.md",
      details: {
        path: "~/Documents/Taxes/letter-to-tax-office.md",
        pathResolved: "/Users/you/Documents/Taxes/letter-to-tax-office.md",
        mode: "create",
        bytes: 412,
        contentHash: fakeSha("content:tax-letter"),
        diff: TAX_DIFF,
        reason: "balanced mode; write outside the workspace",
      },
      grantKey: "file.write|/Users/you/Documents/Taxes/letter-to-tax-office.md",
      requestedBy: {
        runId: R.tax,
        taskId: IDS.tasks.tax,
        threadId: T.main,
        toolCallId: TC.taxWrite,
        agent: "Wren",
      },
      sideEffect: "write",
      targetKind: "path",
      target: {
        kind: "path",
        value: "/Users/you/Documents/Taxes/letter-to-tax-office.md",
        display: "~/Documents/Taxes/letter-to-tax-office.md",
      },
      scopesOffered: ["once", "task"],
      requestedAt: today("09:52", "30"),
      expiresAt: today("10:52", "30"),
    }),
    approval({
      id: A.purchase,
      kind: "purchase",
      summary: "Pay €412.80 to Atlântico Air",
      details: {
        merchant: "Atlântico Air",
        merchantOrigin: "https://booking.atlantico-air.example",
        amount: 412.8,
        currency: "EUR",
        amountDisplay: "€412.80",
        lineItems: [
          { name: "SFO → LIS, Thu Nov 5, economy", quantity: 1, amount: 214.4 },
          { name: "LIS → SFO, Mon Nov 9, economy", quantity: 1, amount: 168.4 },
          { name: "Seat selection", quantity: 2, amount: 15 },
        ],
        lineItemsHash: fakeSha("lines:lisbon-fare"),
        paymentMethod: "stripe-link",
        paymentMethodDisplay: "Link wallet · Visa 4242",
        reason: "purchases always ask; needs Touch ID",
      },
      grantKey: "purchase|https://booking.atlantico-air.example",
      requestedBy: {
        runId: R.lisbon,
        taskId: null,
        threadId: T.lisbon,
        toolCallId: TC.lisbonPurchase,
        agent: "Wren",
      },
      sideEffect: "financial",
      targetKind: "origin",
      target: {
        kind: "origin",
        value: "https://booking.atlantico-air.example",
        display: "atlantico-air.example",
      },
      surfaces: ["desktop", "notification"],
      scopesOffered: ["once"],
      deviceOnly: true,
      requiresAuthentication: true,
      taint: true,
      requestedAt: today("09:25"),
      expiresAt: today("10:25"),
    }),
    approval({
      id: A.mcpTool,
      kind: "mcp_tool",
      summary: "Create a Notion page Lisbon trip",
      details: {
        server: "notion",
        tool: "create_page",
        toolKey: "mcp__notion__create_page",
        args: {
          parent: { database_id: "trips-db" },
          properties: { title: "Lisbon trip", dates: "Nov 6–10", status: "Planning" },
          children: [{ type: "paragraph", text: "Flights: two options, picking dates." }],
        },
        argsHash: fakeSha("args:notion-create-page"),
        trustTier: "community",
        toolsListHash: fakeSha("tools-list:notion:v3"),
        connectorId: IDS.connectors.notion,
        reason: "Notion is connected read-only; this tool writes",
      },
      grantKey: "mcp|notion|create_page",
      requestedBy: {
        runId: R.lisbon,
        taskId: null,
        threadId: T.lisbon,
        toolCallId: TC.lisbonNotion,
        agent: "Wren",
      },
      sideEffect: "write",
      targetKind: "app",
      target: { kind: "app", value: "mcp:notion", display: "Notion" },
      requestedAt: today("09:25", "05"),
      expiresAt: today("10:25", "05"),
    }),

    // --- Decided -------------------------------------------------------------------------------
    approval({
      id: A.approvedOnIphone,
      kind: "calendar_write",
      summary: "Add Hold: dentist to your Google Calendar on Tue Oct 20, 2:30",
      details: {
        account: "google:you@gmail.com",
        calendarId: "primary",
        operation: "create",
        title: "Hold: dentist (Dr. Ortiz)",
        start: "2026-10-20T14:30:00Z",
        end: "2026-10-20T15:30:00Z",
        payloadHash: fakeSha("event:dentist-hold"),
      },
      grantKey: "calendar.write|google:you@gmail.com|primary",
      requestedBy: {
        runId: R.dentistSearch,
        taskId: IDS.tasks.dentist,
        threadId: T.dentist,
        toolCallId: TC.dentistHold,
        agent: "Wren",
      },
      sideEffect: "write",
      targetKind: "account",
      target: { kind: "account", value: "google:you@gmail.com", display: "Google Calendar" },
      taint: true,
      status: "approved",
      scopeGranted: "once",
      decidedBy: { deviceId: IDS.devices.iphone, surface: "notification" },
      decidedAt: today("10:03", "08"),
      grantId: IDS.grants.calendarOnce,
      requestedAt: today("10:02", "50"),
      expiresAt: today("10:32", "50"),
    }),
    approval({
      id: A.denied,
      kind: "message_send",
      summary: "Reply to @sam_k on Telegram",
      details: {
        channel: "telegram",
        account: "@wren_psyche_bot",
        recipient: "@sam_k",
        bodyPreview: "Sure, Thursday works. I'll bring the projector.",
        bodyHash: fakeSha("body:sam-thursday"),
      },
      grantKey: "message.send|telegram|@sam_k",
      requestedBy: { runId: R.main, taskId: null, threadId: T.main, agent: "Wren" },
      sideEffect: "write",
      targetKind: "recipient",
      target: { kind: "recipient", value: "telegram:58213907", display: "@sam_k" },
      status: "denied",
      decidedBy: { deviceId: IDS.devices.mac, surface: "desktop" },
      decidedAt: "2026-10-17T18:04:20Z",
      requestedAt: "2026-10-17T18:03:00Z",
      expiresAt: "2026-10-17T18:33:00Z",
    }),
    approval({
      id: A.expired,
      kind: "browser_submit",
      summary: "Submit the price alert form on shop.example",
      details: {
        origin: "https://shop.example",
        path: "/sonora-h2/alerts",
        fields: ["email", "threshold"],
        fieldValuesDigest: fakeSha("fields:price-alert"),
        submitRef: "e22",
      },
      grantKey: "browser.submit|https://shop.example",
      requestedBy: {
        runId: R.priceWatch,
        taskId: IDS.tasks.priceWatch,
        threadId: T.main,
        agent: "Wren",
      },
      sideEffect: "write",
      targetKind: "origin",
      target: { kind: "origin", value: "https://shop.example", display: "shop.example" },
      taint: true,
      status: "expired",
      requestedAt: "2026-10-18T04:10:00Z",
      expiresAt: "2026-10-18T04:40:00Z",
      decidedAt: "2026-10-18T04:40:00Z",
    }),
    approval({
      id: A.invalidated,
      kind: "file_write",
      summary: "Write ~/Projects/psyche/README.md",
      details: {
        path: "~/Projects/psyche/README.md",
        pathResolved: "/Users/you/Projects/psyche/README.md",
        mode: "replace",
        contentHash: fakeSha("content:readme"),
        diff: WRITE_DIFF_STALE,
      },
      grantKey: "file.write|/Users/you/Projects/psyche/README.md",
      requestedBy: { runId: R.main, taskId: null, threadId: T.main, agent: "Wren" },
      sideEffect: "write",
      targetKind: "path",
      target: {
        kind: "path",
        value: "/Users/you/Projects/psyche/README.md",
        display: "~/Projects/psyche/README.md",
      },
      scopesOffered: ["once", "task"],
      status: "invalidated",
      invalidatedReason: "The file changed on disk after the diff was shown.",
      decidedAt: "2026-10-17T21:15:40Z",
      requestedAt: "2026-10-17T21:12:00Z",
      expiresAt: "2026-10-17T21:42:00Z",
    }),
  ];
}

/** This surface's single-use answer tokens for the pending approvals. */
export function answerTokens(): Record<string, string> {
  return {
    [A.sendEmail]: "at_fixture_1",
    [A.credentialFill]: "at_fixture_2",
    [A.exec]: "at_fixture_3",
    [A.fileWrite]: "at_fixture_4",
    [A.purchase]: "at_fixture_5",
    [A.mcpTool]: "at_fixture_6",
  };
}

export function grants(): Grant[] {
  const G = IDS.grants;
  return [
    {
      id: G.acmeSite,
      kind: "new_origin",
      scope: "always",
      grantKey: "origin|https://acme.com",
      subject: { origin: "https://acme.com", access: "rw" },
      binding: null,
      expiresAt: "2026-11-17T10:00:00Z",
      useCount: 23,
      lastUsedAt: today("10:11", "40"),
      createdFromApprovalId: null,
      taskId: null,
      createdAt: "2026-10-18T09:58:00Z",
      revokedAt: null,
    },
    {
      id: G.gmailRead,
      kind: "connector_action",
      scope: "always",
      grantKey: "connector|conn_gmail|gmail.read",
      subject: { connector: IDS.connectors.gmail, action: "gmail.read" },
      binding: null,
      expiresAt: null,
      useCount: 142,
      lastUsedAt: today("10:02", "37"),
      createdFromApprovalId: null,
      taskId: null,
      createdAt: "2026-10-16T18:20:00Z",
      revokedAt: null,
    },
    {
      id: G.dentistTask,
      kind: "send_email",
      scope: "task",
      grantKey: "email.send|gmail:you@gmail.com|example.com",
      subject: { account: "gmail:you@gmail.com", recipient: "jane.ortiz@example.com" },
      binding: { recipients: ["jane.ortiz@example.com"] },
      expiresAt: null,
      useCount: 1,
      lastUsedAt: today("10:06", "42"),
      createdFromApprovalId: null,
      taskId: IDS.tasks.dentist,
      createdAt: today("10:06", "30"),
      revokedAt: null,
    },
    {
      id: G.calendarOnce,
      kind: "calendar_write",
      scope: "once",
      grantKey: "calendar.write|google:you@gmail.com|primary",
      subject: { account: "google:you@gmail.com", calendarId: "primary" },
      binding: { payloadHash: fakeSha("event:dentist-hold") },
      expiresAt: inMinutes(-8),
      useCount: 1,
      lastUsedAt: today("10:03", "10"),
      createdFromApprovalId: A.approvedOnIphone,
      taskId: IDS.tasks.dentist,
      createdAt: today("10:03", "08"),
      revokedAt: null,
    },
    {
      id: G.revoked,
      kind: "exec",
      scope: "always",
      grantKey: "exec|npm test|/Users/you/Projects/psyche",
      subject: { argv: ["npm", "test"], cwd: "/Users/you/Projects/psyche" },
      binding: null,
      expiresAt: null,
      useCount: 9,
      lastUsedAt: "2026-10-12T14:00:00Z",
      createdFromApprovalId: null,
      taskId: null,
      createdAt: "2026-10-03T11:00:00Z",
      revokedAt: "2026-10-12T14:05:00Z",
    },
  ];
}
