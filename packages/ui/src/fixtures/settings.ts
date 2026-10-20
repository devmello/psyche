import type {
  Channel,
  Connector,
  CredentialMeta,
  CredentialUse,
  Device,
  NodeInfo,
  PairingRequest,
  UsageRecord,
} from "@psyche/protocol";
import { ago, fakeSha, IDS, inMinutes, PERSONA, today } from "./ids.ts";

/** Connectors, channels, pairing, devices, nodes, vault metadata, settings and usage. */

const D = IDS.devices;

// --- Connectors -----------------------------------------------------------------------------------

export function connectors(): Connector[] {
  const C = IDS.connectors;
  return [
    {
      id: C.gmail,
      type: "google",
      label: "Gmail",
      account: "you@gmail.com",
      scopes: ["gmail.readonly", "gmail.send", "calendar.events"],
      scopeMode: "read_act",
      actionMatrix: {
        "gmail.read": "allow",
        "gmail.send": "ask",
        "gmail.delete": "deny",
        "calendar.read": "allow",
        "calendar.write": "ask",
        "calendar.delete": "deny",
      },
      credentialId: null,
      status: "connected",
      config: { syncLabels: ["INBOX", "SENT"], historyDays: 90 },
      lastSync: { at: today("10:05"), messages: 14, events: 3 },
      createdAt: "2026-10-16T18:20:00Z",
      updatedAt: today("10:05"),
    },
    {
      id: C.notion,
      type: "mcp",
      label: "Notion",
      account: "Personal workspace",
      scopes: ["read_content"],
      scopeMode: "read",
      actionMatrix: {
        mcp__notion__search: "allow",
        mcp__notion__fetch: "allow",
        mcp__notion__create_page: "ask",
        mcp__notion__update_page: "deny",
      },
      credentialId: null,
      status: "connected",
      config: {
        transport: "http",
        url: "https://mcp.notion.example/mcp",
        trustTier: "community",
        toolsListHash: fakeSha("tools-list:notion:v3"),
      },
      lastSync: { at: today("09:30"), toolsListChanged: false },
      createdAt: "2026-10-16T18:40:00Z",
      updatedAt: today("09:30"),
    },
    {
      id: C.outlook,
      type: "microsoft",
      label: "Outlook (work)",
      account: "you@work.example",
      scopes: ["Calendars.Read"],
      scopeMode: "read",
      actionMatrix: { "calendar.read": "allow" },
      credentialId: null,
      status: "needs_auth",
      config: { tenant: "work.example" },
      lastSync: { at: "2026-10-14T08:00:00Z", error: "token expired" },
      createdAt: "2026-10-01T10:00:00Z",
      updatedAt: "2026-10-14T08:00:00Z",
    },
  ];
}

// --- Channels and pairing -------------------------------------------------------------------------

export function channels(): Channel[] {
  return [
    {
      id: IDS.channels.telegram,
      type: "telegram",
      account: "@wren_psyche_bot",
      dmPolicy: "pairing",
      allowFrom: ["tg:10442211", "tg:20991834"],
      groupAllowFrom: ["tg:group:-100223344"],
      requireMention: true,
      ownerIds: ["tg:10442211"],
      dmScope: "main",
      nodeId: null,
      status: "active",
      config: {
        allowFromDisplay: { "tg:10442211": "you (owner)", "tg:20991834": "partner" },
        groupsDisplay: { "tg:group:-100223344": "Family" },
      },
      createdAt: "2026-10-16T19:00:00Z",
      updatedAt: "2026-10-17T20:00:00Z",
    },
  ];
}

export function pairingRequests(): PairingRequest[] {
  const P = IDS.pairing;
  return [
    {
      id: P.samK,
      kind: "channel-sender",
      code: "48-21",
      deviceId: null,
      channelId: IDS.channels.telegram,
      senderId: "tg:58213907",
      display: "@sam_k",
      status: "pending",
      createdAt: ago(19),
      expiresAt: inMinutes(41),
      decidedAt: null,
      decidedByDeviceId: null,
    },
    {
      id: P.channelSecond,
      kind: "channel-sender",
      code: "93-07",
      deviceId: null,
      channelId: IDS.channels.telegram,
      senderId: "tg:77120456",
      display: "@marta_lx",
      status: "pending",
      createdAt: ago(5),
      expiresAt: inMinutes(55),
      decidedAt: null,
      decidedByDeviceId: null,
    },
    {
      id: P.ipad,
      kind: "device",
      code: "731-904",
      deviceId: "dev_ipad_pending",
      channelId: null,
      senderId: null,
      display: "iPad Air",
      status: "pending",
      createdAt: ago(2),
      expiresAt: inMinutes(8),
      decidedAt: null,
      decidedByDeviceId: null,
    },
    {
      id: P.approved,
      kind: "channel-sender",
      code: "12-66",
      deviceId: null,
      channelId: IDS.channels.telegram,
      senderId: "tg:20991834",
      display: "partner",
      status: "approved",
      createdAt: "2026-10-17T19:55:00Z",
      expiresAt: "2026-10-17T20:55:00Z",
      decidedAt: "2026-10-17T20:00:00Z",
      decidedByDeviceId: D.mac,
    },
  ];
}

// --- Devices and nodes ----------------------------------------------------------------------------

export function devices(): Device[] {
  return [
    {
      id: D.mac,
      name: "MacBook Pro",
      platform: "macos",
      role: "both",
      publicKey: "mX3k9vQ2c8Lr0yT5uB7wN1eJ4hF6gD2sA9zP0oK3iM8",
      scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin", "node"],
      pairedAt: "2026-10-16T17:50:00Z",
      lastSeenAt: today("10:12"),
      revokedAt: null,
    },
    {
      id: D.iphone,
      name: "iPhone",
      platform: "ios",
      role: "both",
      publicKey: "Qe7Wn2Rt5Yu8Io1Pa4Sd6Fg9Hj3Kl0Zx2Cv5Bn8Mm1Q",
      scopes: ["operator.read", "operator.write", "operator.approvals", "node"],
      pairedAt: "2026-10-16T18:05:00Z",
      lastSeenAt: today("10:03", "08"),
      revokedAt: null,
    },
    {
      id: D.web,
      name: "Firefox on work laptop",
      platform: "web",
      role: "client",
      publicKey: "Zt4Yx7Wv0Us3Rq6Po9Nm2Lk5Jh8Gf1Ed4Cb7Az0Yx3W",
      scopes: ["operator.read", "operator.write"],
      pairedAt: "2026-10-17T09:00:00Z",
      lastSeenAt: "2026-10-17T17:45:00Z",
      revokedAt: null,
    },
    {
      id: D.revoked,
      name: "Old ThinkPad",
      platform: "linux",
      role: "client",
      publicKey: "Hb2Nc5Md8Le1Kf4Jg7Ih0Gi3Fj6Ek9Dl2Cm5Bn8Ao1P",
      scopes: ["operator.read"],
      pairedAt: "2026-09-01T12:00:00Z",
      lastSeenAt: "2026-09-30T22:00:00Z",
      revokedAt: "2026-10-01T08:00:00Z",
    },
  ];
}

export function nodes(): NodeInfo[] {
  return [
    {
      id: IDS.nodes.macHelper,
      deviceId: D.mac,
      kind: "mac-helper",
      capabilities: [
        { name: "computer.screenshot", sideEffect: "read", targetKind: "app" },
        { name: "computer.click", sideEffect: "write", targetKind: "app" },
        { name: "computer.type", sideEffect: "write", targetKind: "app" },
        { name: "notify.show", sideEffect: "none" },
        { name: "quicklook.preview", sideEffect: "read", targetKind: "path" },
      ],
      status: "online",
      lastHeartbeatAt: today("10:11", "50"),
    },
    {
      id: IDS.nodes.phone,
      deviceId: D.iphone,
      kind: "phone",
      capabilities: [
        { name: "notify.show", sideEffect: "none" },
        { name: "location.current", sideEffect: "read" },
      ],
      status: "offline",
      lastHeartbeatAt: today("10:03", "10"),
    },
  ];
}

// --- Vault metadata -------------------------------------------------------------------------------

export function credentials(): CredentialMeta[] {
  const C = IDS.credentials;
  return [
    {
      id: C.github,
      kind: "login",
      name: "GitHub",
      slug: "github-login",
      bindings: [{ origin: "https://github.com" }],
      ownerConnectorId: null,
      lastUsedAt: ago(120),
      useCount: 14,
      createdAt: "2026-10-16T19:10:00Z",
      updatedAt: "2026-10-16T19:10:00Z",
    },
    {
      id: C.stripe,
      kind: "payment_link",
      name: "Link wallet",
      slug: "stripe-link",
      bindings: [{ connector: "stripe_link" }],
      ownerConnectorId: null,
      lastUsedAt: null,
      useCount: 0,
      createdAt: "2026-10-16T19:12:00Z",
      updatedAt: "2026-10-16T19:12:00Z",
    },
    {
      id: C.acme,
      kind: "login",
      name: "acme.com",
      slug: "acme-login",
      bindings: [{ origin: "https://acme.com" }],
      ownerConnectorId: null,
      lastUsedAt: "2026-09-12T15:00:00Z",
      useCount: 2,
      createdAt: "2026-09-12T14:58:00Z",
      updatedAt: "2026-09-12T14:58:00Z",
    },
  ];
}

/** The fill audit (`vault.uses`, feature G14), newest first per item. Never values. */
export function credentialUses(): CredentialUse[] {
  const C = IDS.credentials;
  return [
    {
      id: "use_github_1",
      credentialId: C.github,
      taskId: IDS.tasks.subscriptionAudit,
      approvalId: null,
      executor: "browser",
      target: "https://github.com/login",
      outcome: "filled",
      reason: null,
      createdAt: ago(120),
    },
    {
      id: "use_github_2",
      credentialId: C.github,
      taskId: IDS.tasks.subscriptionAudit,
      approvalId: "ap_github_fill_2",
      executor: "browser",
      target: "https://github.com/session",
      outcome: "denied",
      reason: "You denied the fill.",
      createdAt: ago(26 * 60),
    },
    {
      id: "use_github_3",
      credentialId: C.github,
      taskId: null,
      approvalId: null,
      executor: "sandbox",
      target: "git push (github.com)",
      outcome: "failed",
      reason: "GitHub rejected the password; it may have changed.",
      createdAt: ago(3 * 24 * 60),
    },
    {
      id: "use_acme_1",
      credentialId: C.acme,
      taskId: IDS.tasks.priceWatch,
      approvalId: IDS.approvals.credentialFill,
      executor: "browser",
      target: "https://acme.com/login",
      outcome: "filled",
      reason: null,
      createdAt: "2026-09-12T15:00:00Z",
    },
    {
      id: "use_acme_2",
      credentialId: C.acme,
      taskId: IDS.tasks.priceWatch,
      approvalId: null,
      executor: "browser",
      target: "https://acme.com/login",
      outcome: "failed",
      reason: "The login form had no password field.",
      createdAt: "2026-09-12T14:59:00Z",
    },
  ];
}

// --- Settings -------------------------------------------------------------------------------------

export function settings(): Record<string, unknown> {
  return {
    "appearance.theme": "auto",
    "appearance.accentSeed": "#6e56cf",
    "appearance.gray": "auto",
    "appearance.density": "comfortable",
    "appearance.reduceMotion": "system",
    "appearance.contrast": "standard",
    "permissions.mode": "balanced",
    "persona.name": PERSONA.name,
    "persona.creature": "a small pale moth with lantern eyes",
    "persona.emoji": PERSONA.emoji,
    "persona.tagline": PERSONA.tagline,
    "models.primary": "anthropic/claude-sonnet-5-5",
    "models.utility": "anthropic/claude-haiku-5",
    "memory.paused": false,
    "feed.briefTime": "07:00",
    "feed.postsPerDay": 7,
    "notifications.quietHours": { start: "22:30", end: "07:00" },
    "approvals.defaultExpiryMinutes": 30,
    "usage.monthlyBudgetUsd": 20,
  };
}

// --- Usage ----------------------------------------------------------------------------------------

/**
 * Usage screen and menu-bar meter (UI design §3.18, §3.22). The protocol has `UsageRecord` but
 * no summary shape yet, so the summary is a UI-local type around validated records.
 */
export interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  budgetUsd: number;
  spentUsd: number;
  todayUsd: number;
  percentRemaining: number;
  byThread: { threadId: string; title: string; costUsd: number; tokens: number }[];
  byAutomation: { automationId: string; title: string; costUsd: number; runs: number }[];
  records: UsageRecord[];
}

export function usage(): UsageSummary {
  const R = IDS.runs;
  const rec = (
    id: string,
    runId: string | null,
    job: string | null,
    input: number,
    output: number,
    cacheRead: number,
    costUsd: number,
    createdAt: string,
  ): UsageRecord => ({
    id,
    runId,
    job,
    modelRef: "anthropic/claude-sonnet-5-5",
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning: 0,
    costUsd,
    createdAt,
  });
  return {
    periodStart: "2026-10-01T00:00:00Z",
    periodEnd: "2026-11-01T00:00:00Z",
    budgetUsd: 20,
    spentUsd: 7.6,
    todayUsd: 0.41,
    percentRemaining: 62,
    byThread: [
      { threadId: IDS.threads.main, title: "Main chat", costUsd: 3.12, tokens: 812_000 },
      { threadId: IDS.threads.dentist, title: "Dentist booking", costUsd: 0.112, tokens: 34_100 },
      { threadId: IDS.threads.lisbon, title: "Lisbon trip", costUsd: 0.051, tokens: 20_180 },
    ],
    byAutomation: [
      {
        automationId: IDS.automations.morningBrief,
        title: "Morning brief",
        costUsd: 1.84,
        runs: 13,
      },
      { automationId: IDS.automations.heartbeat, title: "Heartbeat", costUsd: 0.92, runs: 540 },
      {
        automationId: IDS.automations.headphonesWatch,
        title: "Watch: headphones",
        costUsd: 0.18,
        runs: 70,
      },
    ],
    records: [
      rec("use_01", R.dentistSearch, null, 18_200, 1640, 12_900, 0.083, today("10:07", "30")),
      rec("use_02", R.dentistBook, null, 7300, 410, 6200, 0.029, today("10:11", "45")),
      rec("use_03", R.priceWatch, null, 2100, 90, 1800, 0.006, today("10:09", "05")),
      rec("use_04", null, "memory.flush", 3400, 260, 0, 0.012, today("06:00")),
      rec("use_05", null, "feed.brief", 22_000, 1900, 4000, 0.094, today("07:00")),
    ],
  };
}
