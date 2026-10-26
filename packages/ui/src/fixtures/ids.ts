/**
 * Shared constants for the fixture world: the fixed clock, the persona and every id.
 * Ids are short readable strings (the protocol accepts any non-empty id ≤ 64 chars in tests).
 */

/** The fixture world's "now". Every timestamp is relative to it. */
export const FIXTURE_NOW = "2026-10-18T10:12:00Z";

const NOW_MS = Date.parse(FIXTURE_NOW);

export const PERSONA = {
  name: "Wren",
  creature: "moth",
  emoji: "🦋",
  tagline: "Quiet wings, careful hands.",
} as const;

/** ISO-8601 timestamp `seconds` after FIXTURE_NOW (negative for the past), without milliseconds. */
export function at(seconds: number): string {
  return new Date(NOW_MS + seconds * 1000).toISOString().replace(".000Z", "Z");
}

/** Minutes before FIXTURE_NOW. */
export function ago(minutes: number): string {
  return at(-minutes * 60);
}

/** Minutes after FIXTURE_NOW. */
export function inMinutes(minutes: number): string {
  return at(minutes * 60);
}

/** Clock time on the fixture day, e.g. `today("10:02")`. */
export function today(hhmm: string, ss = "00"): string {
  return `2026-10-18T${hhmm}:${ss}Z`;
}

/** Deterministic 64-hex digest of a seed (FNV-1a lanes; not cryptographic, fixtures only). */
export function fakeHex(seed: string): string {
  let out = "";
  for (let lane = 0; lane < 8; lane++) {
    let h = 0x811c9dc5 ^ lane;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
    out += (h >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

/** `sha256:<64 hex>` binding / content hash for fixtures. */
export function fakeSha(seed: string): `sha256:${string}` {
  return `sha256:${fakeHex(seed)}`;
}

export const IDS = {
  threads: {
    main: "th_main",
    dentist: "th_dentist",
    lisbon: "th_lisbon",
    archived: "th_permission_slip",
    incognito: "th_incognito",
  },
  messages: {
    mainBootstrap: "msg_main_01",
    mainUser: "msg_main_02",
    mainAgent: "msg_main_03",
    mainUserTax: "msg_main_04",
    mainAgentTax: "msg_main_05",
    dentistUser: "msg_dentist_01",
    dentistStart: "msg_dentist_02",
    dentistSlots: "msg_dentist_03",
    dentistSystem: "msg_dentist_04",
    dentistLogin: "msg_dentist_05",
    dentistQuestion: "msg_dentist_06",
    dentistResults: "msg_dentist_07",
    dentistPriceWatch: "msg_dentist_08",
    dentistWrapUp: "msg_dentist_09",
    lisbonUser: "msg_lisbon_01",
    lisbonAgent: "msg_lisbon_02",
    lisbonApprovals: "msg_lisbon_03",
    archivedUser: "msg_slip_01",
    archivedAgent: "msg_slip_02",
    incognitoUser: "msg_incog_01",
    incognitoAgent: "msg_incog_02",
  },
  runs: {
    main: "run_main_01",
    tax: "run_main_02",
    dentistSearch: "run_dentist_01",
    dentistBook: "run_dentist_02",
    lisbon: "run_lisbon_01",
    priceWatch: "run_price_watch_01",
    subscriptionAudit: "run_sub_audit_01",
    archived: "run_slip_01",
    incognito: "run_incog_01",
  },
  toolCalls: {
    dentistNavigate: "tc_dentist_navigate",
    dentistCalendar: "tc_dentist_calendar",
    dentistFillDate: "tc_dentist_fill_date",
    dentistHold: "tc_dentist_hold",
    dentistCredential: "tc_dentist_credential",
    dentistEmail: "tc_dentist_email",
    dentistBook: "tc_dentist_book",
    dentistSendConfirm: "tc_dentist_send_confirm",
    mainExec: "tc_main_exec",
    taxWrite: "tc_tax_write",
    lisbonSearch: "tc_lisbon_search",
    lisbonPurchase: "tc_lisbon_purchase",
    lisbonNotion: "tc_lisbon_notion",
  },
  tasks: {
    dentist: "task_dentist",
    tax: "task_tax_letter",
    priceWatch: "task_price_watch",
    subscriptionAudit: "task_sub_audit",
    lisbon: "task_lisbon_research",
  },
  approvals: {
    sendEmail: "ap_send_email",
    exec: "ap_exec",
    credentialFill: "ap_credential_fill",
    purchase: "ap_purchase",
    fileWrite: "ap_file_write",
    mcpTool: "ap_mcp_tool",
    approvedOnIphone: "ap_calendar_approved",
    denied: "ap_message_denied",
    expired: "ap_submit_expired",
    invalidated: "ap_write_invalidated",
  },
  inputRequests: {
    dentistSlot: "ir_dentist_slot",
    lisbonDates: "ir_lisbon_dates",
    answered: "ir_calendar_choice",
  },
  receipts: {
    browserRead: "rc_browser_read",
    emailSent: "rc_email_sent",
    holdUncertain: "rc_hold_uncertain",
    cancelFailed: "rc_cancel_failed",
    calendarWrite: "rc_calendar_write",
  },
  artifacts: {
    itinerary: "art_tuesday_itinerary",
    planPdf: "art_half_marathon_plan",
    auditHtml: "art_subscription_report",
  },
  library: {
    intakeForm: "lib_intake_form",
    permissionSlip: "lib_permission_slip",
    avatar: "lib_avatar_wren",
    receiptScan: "lib_receipt_scan",
    itinerary: "lib_art_itinerary",
    planPdf: "lib_art_plan",
    auditHtml: "lib_art_audit",
    invoiceDownload: "lib_invoice_download",
    soul: "lib_sys_soul",
    identity: "lib_sys_identity",
    user: "lib_sys_user",
    memory: "lib_sys_memory",
    agents: "lib_sys_agents",
    dailyNote: "lib_sys_daily_1018",
  },
  notifications: {
    approval: "ntf_approval_email",
    inputNeeded: "ntf_input_lisbon",
    taskDone: "ntf_done_price_watch",
    taskFailed: "ntf_failed_sub_audit",
    proactive: "ntf_idea_subscription",
    briefing: "ntf_brief_ready",
    reminder: "ntf_reminder_checkin",
    system: "ntf_system_nightly",
  },
  feed: {
    briefing: "post_briefing",
    reminder: "post_reminder",
    suggestion: "post_suggestion",
    watch: "post_watch",
    news: "post_news_cluster",
    exploration: "post_exploration",
    lisbon: "post_lisbon_trams",
  },
  briefing: "brief_2026_10_18",
  ideas: {
    subscription: "idea_cancel_streaming",
    skill: "idea_skill_expense_export",
    automation: "idea_weekly_review",
    connector: "idea_connect_calendar",
    accepted: "idea_dentist_reminder",
  },
  goals: {
    halfMarathon: "goal_half_marathon",
    sleep: "goal_sleep",
    emergencyFund: "goal_emergency_fund",
    career: "goal_ship_ui_kit",
    candidate: "goal_portuguese",
  },
  automations: {
    morningBrief: "auto_morning_brief",
    subscriptionAudit: "auto_sub_audit",
    headphonesWatch: "auto_watch_headphones",
    heartbeat: "auto_heartbeat",
    reminder: "auto_reminder_sam",
  },
  grants: {
    acmeSite: "grant_acme_site",
    gmailRead: "grant_gmail_read",
    dentistTask: "grant_dentist_task",
    calendarOnce: "grant_calendar_once",
    revoked: "grant_revoked_exec",
  },
  connectors: {
    gmail: "conn_gmail",
    notion: "conn_notion",
    outlook: "conn_outlook",
    appleMail: "conn_apple_mail",
    appleNotes: "conn_apple_notes",
    appleCalendar: "conn_apple_calendar",
    appleReminders: "conn_apple_reminders",
  },
  channels: {
    telegram: "chan_telegram",
  },
  pairing: {
    samK: "pair_sam_k",
    channelSecond: "pair_tg_unknown",
    ipad: "pair_ipad",
    approved: "pair_partner",
  },
  devices: {
    mac: "dev_mac",
    iphone: "dev_iphone",
    web: "dev_web",
    revoked: "dev_old_laptop",
  },
  nodes: {
    macHelper: "node_mac_helper",
    phone: "node_iphone",
  },
  credentials: {
    github: "cred_github_login",
    stripe: "cred_stripe_link",
    acme: "cred_acme_login",
  },
  claims: {
    mornings: "claim_mornings",
    dentist: "claim_dentist",
    sam: "claim_sam",
    shortReplies: "claim_short_replies",
    retracted: "claim_retracted",
    imported: "claim_imported",
  },
  browserSession: "bs_dentist",
  sandbox: "sbx_main",
} as const;
