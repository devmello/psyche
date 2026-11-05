//! Pure planning for `notify.show` (port of `NotificationParams.swift`, `NotificationPlan.swift`,
//! `NotificationResponse.swift`, `QuietHours.swift`, `Presence.swift`), plus the Windows pieces
//! that are pure too: the toast XML and the activation-argument encoding that carries the
//! ids-only metadata the mac helper keeps in `userInfo`.

use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::node::capability::CapabilityError;
use crate::node::encoding::sha256;

pub const MAX_TITLE: usize = 120;
pub const MAX_SUBTITLE: usize = 120;
pub const MAX_BODY: usize = 1000;
pub const MAX_ACTION_LABEL: usize = 64;
pub const MAX_PLACEHOLDER: usize = 120;
/// Buttons plus the text reply.
pub const MAX_ACTIONS: usize = 4;
pub const MAX_ID_LENGTH: usize = 128;
pub const ID_PATTERN: &str = "^[A-Za-z0-9_.:-]{1,128}$";

pub const DEFAULT_ACTION_ID: &str = "default";
pub const DISMISS_ACTION_ID: &str = "dismiss";
pub const REPLY_ACTION_ID: &str = "reply";

pub fn is_valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_ID_LENGTH && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// Truncates to at most `max` characters, ending with "…" when shortened.
pub fn truncate(s: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if s.chars().count() <= max {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(max - 1).collect();
    out.push('…');
    out
}

/// `presenceChallenge`: 64 hex characters (a hex SHA-256).
pub fn is_valid_challenge(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The bytes the presence key signs: `psyche.presence.helper.v1|<challenge>`.
pub fn presence_message(challenge: &str) -> Vec<u8> {
    format!("psyche.presence.helper.v1|{challenge}").into_bytes()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationKind {
    Approval,
    InputNeeded,
    TaskDone,
    TaskFailed,
    Proactive,
    Briefing,
    Reminder,
    System,
    SpecialistResult,
}

impl NotificationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NotificationKind::Approval => "approval",
            NotificationKind::InputNeeded => "input_needed",
            NotificationKind::TaskDone => "task_done",
            NotificationKind::TaskFailed => "task_failed",
            NotificationKind::Proactive => "proactive",
            NotificationKind::Briefing => "briefing",
            NotificationKind::Reminder => "reminder",
            NotificationKind::System => "system",
            NotificationKind::SpecialistResult => "specialist_result",
        }
    }

    pub const NAMES: [&'static str; 8] = ["approval", "input_needed", "task_done", "task_failed", "proactive", "briefing", "reminder", "system"];
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Interruption {
    #[serde(rename = "passive")]
    Passive,
    #[serde(rename = "active")]
    Active,
    #[serde(rename = "timeSensitive")]
    TimeSensitive,
}

impl Interruption {
    pub fn as_str(self) -> &'static str {
        match self {
            Interruption::Passive => "passive",
            Interruption::Active => "active",
            Interruption::TimeSensitive => "timeSensitive",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyAction {
    pub id: String,
    pub label: String,
    pub destructive: Option<bool>,
    pub requires_auth: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NotifyReply {
    pub label: String,
    #[serde(default)]
    pub placeholder: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct QuietHoursParams {
    pub start: String,
    pub end: String,
}

/// Wire action: this helper's names and S15's (`authenticationRequired`, `textInput`).
#[derive(Deserialize)]
struct WireAction {
    id: String,
    label: String,
    destructive: Option<bool>,
    #[serde(rename = "requiresAuth")]
    requires_auth: Option<bool>,
    #[serde(rename = "authenticationRequired")]
    authentication_required: Option<bool>,
    #[serde(rename = "textInput")]
    text_input: Option<bool>,
}

#[derive(Deserialize)]
struct RawShow {
    id: String,
    kind: Option<NotificationKind>,
    category: Option<NotificationKind>,
    title: String,
    body: String,
    subtitle: Option<String>,
    actions: Option<Vec<WireAction>>,
    reply: Option<NotifyReply>,
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
    route: Option<String>,
    interruption: Option<Interruption>,
    #[serde(rename = "interruptionLevel")]
    interruption_level: Option<Interruption>,
    #[serde(rename = "approvalId")]
    approval_id: Option<String>,
    #[serde(rename = "requireBiometry")]
    require_biometry: Option<bool>,
    #[serde(rename = "quietHours")]
    quiet_hours: Option<QuietHoursParams>,
    sound: Option<bool>,
    #[serde(rename = "presenceChallenge")]
    presence_challenge: Option<String>,
}

/// `notify.show` parameters (both naming schemes accepted, as the Swift decoder does).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotifyShowParams {
    pub id: String,
    pub kind: NotificationKind,
    pub title: String,
    pub body: String,
    pub subtitle: Option<String>,
    pub actions: Option<Vec<NotifyAction>>,
    pub reply: Option<NotifyReply>,
    pub thread_id: Option<String>,
    pub route: Option<String>,
    pub interruption: Option<Interruption>,
    pub approval_id: Option<String>,
    pub require_biometry: Option<bool>,
    pub quiet_hours: Option<QuietHoursParams>,
    pub sound: Option<bool>,
    pub presence_challenge: Option<String>,
}

impl NotifyShowParams {
    pub fn from_value(v: &Value) -> Result<NotifyShowParams, CapabilityError> {
        let raw: RawShow = crate::node::capability::decode_params(v)?;
        let kind = raw.kind.or(raw.category).ok_or_else(|| CapabilityError::invalid_params("missing parameter kind", Some("kind")))?;
        let mut reply = raw.reply;
        let actions = raw.actions.map(|wire| {
            let mut buttons = Vec::new();
            for a in wire {
                if a.text_input == Some(true) {
                    reply = reply.clone().or(Some(NotifyReply { label: a.label, placeholder: None }));
                } else {
                    buttons.push(NotifyAction {
                        id: a.id,
                        label: a.label,
                        destructive: a.destructive,
                        requires_auth: a.requires_auth.or(a.authentication_required),
                    });
                }
            }
            buttons
        });
        if let Some(pc) = &raw.presence_challenge
            && !is_valid_challenge(pc)
        {
            return Err(CapabilityError::invalid_params("presenceChallenge must be 64 hex characters", Some("presenceChallenge")));
        }
        Ok(NotifyShowParams {
            id: raw.id,
            kind,
            title: raw.title,
            body: raw.body,
            subtitle: raw.subtitle,
            // An empty list from S15 means "use the kind's defaults".
            actions: actions.filter(|b| !b.is_empty()),
            reply,
            thread_id: raw.thread_id,
            route: raw.route,
            interruption: raw.interruption.or(raw.interruption_level),
            approval_id: raw.approval_id,
            require_biometry: raw.require_biometry,
            quiet_hours: raw.quiet_hours,
            sound: raw.sound,
            presence_challenge: raw.presence_challenge,
        })
    }
}

/// Daily window in local time; `end <= start` wraps past midnight; `start == end` is empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuietHours {
    pub start_minute: u32,
    pub end_minute: u32,
}

impl QuietHours {
    pub fn parse_hhmm(text: &str) -> Option<u32> {
        let (h, m) = text.split_once(':')?;
        if h.len() != 2 || m.len() != 2 || !h.bytes().chain(m.bytes()).all(|b| b.is_ascii_digit()) {
            return None;
        }
        let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
        (h <= 23 && m <= 59).then_some(h * 60 + m)
    }

    pub fn new(start: &str, end: &str) -> Option<QuietHours> {
        Some(QuietHours { start_minute: Self::parse_hhmm(start)?, end_minute: Self::parse_hhmm(end)? })
    }

    pub fn contains(&self, minute: u32) -> bool {
        if self.start_minute == self.end_minute {
            false
        } else if self.start_minute < self.end_minute {
            minute >= self.start_minute && minute < self.end_minute
        } else {
            minute >= self.start_minute || minute < self.end_minute
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ActionPlan {
    pub id: String,
    pub label: String,
    pub destructive: bool,
    pub requires_auth: bool,
    /// Placeholder of the inline text reply, for the reply action.
    pub text_input: Option<String>,
}

impl ActionPlan {
    fn button(id: &str, label: &str, destructive: bool) -> ActionPlan {
        ActionPlan { id: id.into(), label: label.into(), destructive, requires_auth: false, text_input: None }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CategoryPlan {
    pub identifier: String,
    pub actions: Vec<ActionPlan>,
}

/// The ids-only metadata that rides in the toast's activation arguments (never title or body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserInfo {
    pub notification_id: String,
    pub kind: String,
    pub approval_id: Option<String>,
    pub require_biometry: bool,
    pub destructive_action_ids: Vec<String>,
    pub presence_challenge: Option<String>,
}

impl UserInfo {
    /// Only when asked, and never for a dismissal, a plain click on the toast (it only opens the
    /// app) or a destructive action (deny is always allowed).
    pub fn needs_authentication(&self, action_id: &str) -> bool {
        self.require_biometry
            && action_id != DISMISS_ACTION_ID
            && action_id != DEFAULT_ACTION_ID
            && !self.destructive_action_ids.iter().any(|d| d == action_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationPlan {
    pub id: String,
    pub kind: NotificationKind,
    pub title: String,
    pub subtitle: Option<String>,
    pub body: String,
    pub thread_id: Option<String>,
    pub category: CategoryPlan,
    pub interruption: Interruption,
    pub requested_interruption: Interruption,
    pub quiet_hours_applied: bool,
    pub play_sound: bool,
    pub approval_id: Option<String>,
    pub require_biometry: bool,
    pub presence_challenge: Option<String>,
}

pub fn default_interruption(kind: NotificationKind) -> Interruption {
    match kind {
        NotificationKind::Approval | NotificationKind::InputNeeded => Interruption::TimeSensitive,
        NotificationKind::Proactive | NotificationKind::Briefing => Interruption::Passive,
        _ => Interruption::Active,
    }
}

pub fn default_buttons(kind: NotificationKind) -> Vec<ActionPlan> {
    match kind {
        NotificationKind::Approval => vec![ActionPlan::button("approve", "Approve", false), ActionPlan::button("deny", "Deny", true)],
        NotificationKind::InputNeeded => vec![],
        NotificationKind::TaskFailed => vec![ActionPlan::button("open", "Open", false), ActionPlan::button("retry", "Retry", false)],
        NotificationKind::Reminder => vec![ActionPlan::button("open", "Open", false), ActionPlan::button("snooze", "Snooze", false)],
        _ => vec![ActionPlan::button("open", "Open", false)],
    }
}

fn default_reply() -> NotifyReply {
    NotifyReply { label: "Reply".into(), placeholder: Some("Type your answer".into()) }
}

fn reply_action(r: &NotifyReply) -> ActionPlan {
    ActionPlan {
        id: REPLY_ACTION_ID.into(),
        label: truncate(&r.label, MAX_ACTION_LABEL),
        destructive: false,
        requires_auth: false,
        text_input: Some(truncate(r.placeholder.as_deref().unwrap_or(""), MAX_PLACEHOLDER)),
    }
}

/// The fixed categories (mac `defaultCategories`), so `category` matches the mac helper's.
pub fn default_categories() -> Vec<CategoryPlan> {
    vec![
        CategoryPlan { identifier: "psyche.approval".into(), actions: default_buttons(NotificationKind::Approval) },
        CategoryPlan { identifier: "psyche.input_needed".into(), actions: vec![reply_action(&default_reply())] },
        CategoryPlan { identifier: "psyche.task_failed".into(), actions: default_buttons(NotificationKind::TaskFailed) },
        CategoryPlan { identifier: "psyche.reminder".into(), actions: default_buttons(NotificationKind::Reminder) },
        CategoryPlan { identifier: "psyche.open".into(), actions: default_buttons(NotificationKind::System) },
    ]
}

/// `psyche.custom.<first 8 bytes of SHA-256, hex>` over the canonical action list.
pub fn custom_category_id(actions: &[ActionPlan]) -> String {
    let canonical: Vec<String> = actions
        .iter()
        .map(|a| {
            [
                a.id.clone(),
                a.label.clone(),
                if a.destructive { "d".into() } else { "-".into() },
                if a.requires_auth { "a".into() } else { "-".into() },
                a.text_input.as_ref().map_or("-".into(), |p| format!("t:{p}")),
            ]
            .join("\u{1F}")
        })
        .collect();
    let digest = sha256(format!("v1\u{1D}{}", canonical.join("\u{1E}")).as_bytes());
    format!("psyche.custom.{}", crate::node::encoding::hex(&digest[..8]))
}

pub fn category_for(actions: Vec<ActionPlan>) -> CategoryPlan {
    if let Some(known) = default_categories().into_iter().find(|c| c.actions == actions) {
        return known;
    }
    CategoryPlan { identifier: custom_category_id(&actions), actions }
}

/// Reply first (when any), then the buttons (custom, or the kind's defaults).
pub fn action_list(kind: NotificationKind, buttons: Option<&[NotifyAction]>, reply: Option<&NotifyReply>) -> Result<Vec<ActionPlan>, CapabilityError> {
    let mut list = Vec::new();
    let default = default_reply();
    let reply = reply.or(if kind == NotificationKind::InputNeeded { Some(&default) } else { None });
    if let Some(r) = reply {
        if r.label.trim().is_empty() {
            return Err(CapabilityError::invalid_params("reply.label must not be empty", Some("reply.label")));
        }
        list.push(reply_action(r));
    }
    match buttons {
        Some(buttons) => {
            for (i, b) in buttons.iter().enumerate() {
                if !is_valid_id(&b.id) {
                    return Err(CapabilityError::invalid_params(format!("actions[{i}].id must match {ID_PATTERN}"), Some("actions")));
                }
                if b.id == DEFAULT_ACTION_ID || b.id == DISMISS_ACTION_ID {
                    return Err(CapabilityError::invalid_params(format!("actions[{i}].id {} is reserved", b.id), Some("actions")));
                }
                if b.label.trim().is_empty() {
                    return Err(CapabilityError::invalid_params(format!("actions[{i}].label must not be empty"), Some("actions")));
                }
                list.push(ActionPlan {
                    id: b.id.clone(),
                    label: truncate(&b.label, MAX_ACTION_LABEL),
                    destructive: b.destructive.unwrap_or(false),
                    requires_auth: b.requires_auth.unwrap_or(false),
                    text_input: None,
                });
            }
        }
        None => list.extend(default_buttons(kind)),
    }
    if list.len() > MAX_ACTIONS {
        return Err(CapabilityError::invalid_params(format!("at most {MAX_ACTIONS} actions (including the reply)"), Some("actions")));
    }
    let mut seen = std::collections::HashSet::new();
    if !list.iter().all(|a| seen.insert(a.id.clone())) {
        return Err(CapabilityError::invalid_params("action ids must be unique (\"reply\" is used by the text reply)", Some("actions")));
    }
    Ok(list)
}

impl NotificationPlan {
    /// Builds the plan; `minute_of_day` is the local wall clock (for quiet hours).
    pub fn make(p: &NotifyShowParams, minute_of_day: u32) -> Result<NotificationPlan, CapabilityError> {
        if !is_valid_id(&p.id) {
            return Err(CapabilityError::invalid_params(format!("id must match {ID_PATTERN}"), Some("id")));
        }
        if let Some(t) = &p.thread_id
            && !is_valid_id(t)
        {
            return Err(CapabilityError::invalid_params(format!("threadId must match {ID_PATTERN}"), Some("threadId")));
        }
        if let Some(a) = &p.approval_id
            && !is_valid_id(a)
        {
            return Err(CapabilityError::invalid_params(format!("approvalId must match {ID_PATTERN}"), Some("approvalId")));
        }
        let title = p.title.trim();
        if title.is_empty() {
            return Err(CapabilityError::invalid_params("title must not be empty", Some("title")));
        }
        let actions = action_list(p.kind, p.actions.as_deref(), p.reply.as_ref())?;
        let category = category_for(actions);
        let quiet = match &p.quiet_hours {
            Some(q) => Some(QuietHours::new(&q.start, &q.end).ok_or_else(|| {
                CapabilityError::invalid_params("quietHours.start and quietHours.end must be HH:mm", Some("quietHours"))
            })?),
            None => None,
        };
        let requested = p.interruption.unwrap_or_else(|| default_interruption(p.kind));
        let in_quiet = quiet.is_some_and(|q| q.contains(minute_of_day));
        let level = if in_quiet { Interruption::Passive } else { requested };
        let sound = !in_quiet && p.sound.unwrap_or(requested != Interruption::Passive);
        let subtitle = p.subtitle.as_deref().map(|s| truncate(s, MAX_SUBTITLE)).filter(|s| !s.is_empty());
        Ok(NotificationPlan {
            id: p.id.clone(),
            kind: p.kind,
            title: truncate(title, MAX_TITLE),
            subtitle,
            body: truncate(&p.body, MAX_BODY),
            thread_id: p.thread_id.clone(),
            category,
            interruption: level,
            requested_interruption: requested,
            quiet_hours_applied: in_quiet,
            play_sound: sound,
            approval_id: p.approval_id.clone(),
            require_biometry: p.require_biometry.unwrap_or(false),
            presence_challenge: p.presence_challenge.clone(),
        })
    }

    pub fn user_info(&self) -> UserInfo {
        UserInfo {
            notification_id: self.id.clone(),
            kind: self.kind.as_str().into(),
            approval_id: self.approval_id.clone(),
            require_biometry: self.require_biometry,
            destructive_action_ids: self.category.actions.iter().filter(|a| a.destructive).map(|a| a.id.clone()).collect(),
            presence_challenge: if self.require_biometry { self.presence_challenge.clone() } else { None },
        }
    }

    /// Toast tag (at most 64 characters on Windows): the id, or a stable hash of a longer id.
    pub fn tag(&self) -> String {
        tag_for(&self.id)
    }
}

pub fn tag_for(id: &str) -> String {
    if id.len() <= 64 { id.to_owned() } else { format!("h-{}", &crate::node::encoding::sha256_hex(id.as_bytes())[..62]) }
}

// MARK: Activation arguments

fn esc_arg(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '%' | '&' | '=' | ',' | ';' => out.push_str(&format!("%{:02X}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn unesc_arg(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `v=1&n=<id>&a=<action>&k=<kind>[&ap=<approval>][&rb=1][&d=<ids,…>][&pc=<challenge>]`.
pub fn encode_args(info: &UserInfo, action_id: &str) -> String {
    let mut parts = vec![
        "v=1".to_owned(),
        format!("n={}", esc_arg(&info.notification_id)),
        format!("a={}", esc_arg(action_id)),
        format!("k={}", esc_arg(&info.kind)),
    ];
    if let Some(a) = &info.approval_id {
        parts.push(format!("ap={}", esc_arg(a)));
    }
    if info.require_biometry {
        parts.push("rb=1".into());
    }
    if !info.destructive_action_ids.is_empty() {
        parts.push(format!("d={}", info.destructive_action_ids.iter().map(|d| esc_arg(d)).collect::<Vec<_>>().join(",")));
    }
    if let Some(c) = &info.presence_challenge {
        parts.push(format!("pc={c}"));
    }
    parts.join("&")
}

/// Reads activation arguments back; `None` when they are not Psyche's.
pub fn decode_args(args: &str) -> Option<(UserInfo, String)> {
    let mut info = UserInfo {
        notification_id: String::new(),
        kind: "system".into(),
        approval_id: None,
        require_biometry: false,
        destructive_action_ids: vec![],
        presence_challenge: None,
    };
    let mut action = None;
    let mut version = None;
    for pair in args.split('&') {
        let (k, v) = pair.split_once('=')?;
        match k {
            "v" => version = Some(v.to_owned()),
            "n" => info.notification_id = unesc_arg(v)?,
            "a" => action = Some(unesc_arg(v)?),
            "k" => info.kind = unesc_arg(v)?,
            "ap" => info.approval_id = Some(unesc_arg(v)?).filter(|a| is_valid_id(a)),
            "rb" => info.require_biometry = v == "1",
            "d" => info.destructive_action_ids = v.split(',').filter_map(unesc_arg).filter(|d| !d.is_empty()).collect(),
            "pc" => info.presence_challenge = Some(v.to_owned()).filter(|c| is_valid_challenge(c)),
            _ => {}
        }
    }
    let action = action.filter(|a| is_valid_id(a))?;
    (version.as_deref() == Some("1") && is_valid_id(&info.notification_id)).then_some((info, action))
}

// MARK: Toast XML

pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Toast XML (ToastGeneric). Buttons activate the helper's COM activator in the background;
/// time-sensitive toasts with buttons use the `reminder` scenario so they stay on screen until
/// answered; destructive buttons get the critical style.
pub fn toast_xml(plan: &NotificationPlan) -> String {
    let info = plan.user_info();
    let has_buttons = plan.category.actions.iter().any(|a| a.text_input.is_none());
    let scenario = if plan.interruption == Interruption::TimeSensitive && has_buttons { " scenario=\"reminder\"" } else { "" };
    let mut x = format!(
        "<toast launch=\"{}\" activationType=\"background\"{scenario}><visual><binding template=\"ToastGeneric\"><text>{}</text>",
        xml_escape(&encode_args(&info, DEFAULT_ACTION_ID)),
        xml_escape(&plan.title)
    );
    if let Some(s) = &plan.subtitle {
        x.push_str(&format!("<text hint-maxLines=\"1\">{}</text>", xml_escape(s)));
    }
    if !plan.body.is_empty() {
        x.push_str(&format!("<text>{}</text>", xml_escape(&plan.body)));
    }
    x.push_str("</binding></visual>");
    if !plan.category.actions.is_empty() {
        x.push_str("<actions>");
        for a in &plan.category.actions {
            if let Some(placeholder) = &a.text_input {
                x.push_str(&format!("<input id=\"{REPLY_ACTION_ID}\" type=\"text\" placeHolderContent=\"{}\"/>", xml_escape(placeholder)));
            }
        }
        for a in &plan.category.actions {
            let mut attrs = format!(
                "content=\"{}\" arguments=\"{}\" activationType=\"background\"",
                xml_escape(&a.label),
                xml_escape(&encode_args(&info, &a.id))
            );
            if a.text_input.is_some() {
                attrs.push_str(&format!(" hint-inputId=\"{REPLY_ACTION_ID}\""));
            }
            if a.destructive {
                attrs.push_str(" hint-buttonStyle=\"Critical\"");
            }
            x.push_str(&format!("<action {attrs}/>"));
        }
        x.push_str("</actions>");
    }
    if !plan.play_sound {
        x.push_str("<audio silent=\"true\"/>");
    }
    x.push_str("</toast>");
    x
}

// MARK: Responses

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PresenceSignature {
    pub signature: String,
    pub key_id: String,
}

/// A user's answer, forwarded as a `notify.response` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationResponse {
    pub notification_id: String,
    pub action_id: String,
    pub reply_text: Option<String>,
    pub approval_id: Option<String>,
    pub authenticated: bool,
    pub auth_error: Option<String>,
    pub presence: Option<PresenceSignature>,
    pub presence_error: Option<String>,
}

impl NotificationResponse {
    pub fn new(notification_id: &str, action_id: &str, reply_text: Option<String>, approval_id: Option<String>) -> Self {
        NotificationResponse {
            notification_id: notification_id.into(),
            action_id: action_id.into(),
            reply_text,
            approval_id,
            authenticated: false,
            auth_error: None,
            presence: None,
            presence_error: None,
        }
    }

    pub fn payload(&self) -> Value {
        let mut o = Map::new();
        o.insert("type".into(), "notify.response".into());
        o.insert("notificationId".into(), self.notification_id.clone().into());
        o.insert("actionId".into(), self.action_id.clone().into());
        o.insert("authenticated".into(), self.authenticated.into());
        if let Some(t) = &self.reply_text {
            o.insert("replyText".into(), t.clone().into());
            o.insert("text".into(), t.clone().into());
        }
        if let Some(a) = &self.approval_id {
            o.insert("approvalId".into(), a.clone().into());
        }
        if let Some(e) = &self.auth_error {
            o.insert("authError".into(), e.clone().into());
        }
        if let Some(p) = &self.presence {
            o.insert("presence".into(), json!({ "signature": p.signature, "keyId": p.key_id }));
        }
        if let Some(e) = &self.presence_error {
            o.insert("presenceError".into(), e.clone().into());
        }
        Value::Object(o)
    }
}

/// Content-free log label for an action id.
pub fn log_action_class(id: &str) -> &str {
    match id {
        DEFAULT_ACTION_ID | DISMISS_ACTION_ID | REPLY_ACTION_ID => id,
        _ => "custom",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn show(v: Value) -> NotifyShowParams {
        NotifyShowParams::from_value(&v).unwrap()
    }

    #[test]
    fn decodes_both_naming_schemes() {
        let p = show(json!({
            "id": "apr_1", "category": "approval", "title": "T", "body": "B", "interruptionLevel": "timeSensitive",
            "actions": [
                {"id": "approve", "label": "Approve", "destructive": false, "authenticationRequired": true, "textInput": false},
                {"id": "deny", "label": "Deny", "destructive": true, "authenticationRequired": false, "textInput": false}
            ],
            "approvalId": "apr_1", "requireBiometry": true, "threadId": null,
            "presenceChallenge": "ab".repeat(32)
        }));
        assert_eq!(p.kind, NotificationKind::Approval);
        assert_eq!(p.interruption, Some(Interruption::TimeSensitive));
        assert_eq!(p.actions.as_ref().unwrap()[0].requires_auth, Some(true));
        assert!(p.thread_id.is_none());
        let p = show(json!({"id": "x", "kind": "input_needed", "title": "T", "body": "B",
            "actions": [{"id": "r", "label": "Answer", "textInput": true}]}));
        assert_eq!(p.reply.as_ref().unwrap().label, "Answer");
        assert!(p.actions.is_none());
        let e = NotifyShowParams::from_value(&json!({"id": "x", "title": "T", "body": "B"})).unwrap_err();
        assert_eq!(e.details["field"], "kind");
        let e = NotifyShowParams::from_value(&json!({"id": "x", "kind": "system", "title": "T", "body": "B", "presenceChallenge": "zz"})).unwrap_err();
        assert_eq!(e.details["field"], "presenceChallenge");
    }

    #[test]
    fn plans_defaults_quiet_hours_and_limits() {
        let p = show(json!({"id": "n1", "kind": "approval", "title": "  Allow? ", "body": "b"}));
        let plan = NotificationPlan::make(&p, 600).unwrap();
        assert_eq!(plan.category.identifier, "psyche.approval");
        assert_eq!(plan.interruption, Interruption::TimeSensitive);
        assert!(plan.play_sound);
        assert_eq!(plan.title, "Allow?");
        let p = show(json!({"id": "n1", "kind": "task_done", "title": "T", "body": "b", "quietHours": {"start": "22:00", "end": "07:00"}}));
        let plan = NotificationPlan::make(&p, 23 * 60).unwrap();
        assert!(plan.quiet_hours_applied);
        assert_eq!(plan.interruption, Interruption::Passive);
        assert!(!plan.play_sound);
        assert!(!NotificationPlan::make(&p, 12 * 60).unwrap().quiet_hours_applied);
        let p = show(json!({"id": "bad id", "kind": "system", "title": "T", "body": "b"}));
        assert_eq!(NotificationPlan::make(&p, 0).unwrap_err().details["field"], "id");
        let p = show(json!({"id": "x", "kind": "system", "title": "T", "body": "b",
            "actions": [{"id": "a", "label": "1"}, {"id": "b", "label": "2"}, {"id": "c", "label": "3"}, {"id": "d", "label": "4"}],
            "reply": {"label": "R"}}));
        assert!(NotificationPlan::make(&p, 0).is_err());
        let p = show(json!({"id": "x", "kind": "system", "title": "T", "body": "b", "actions": [{"id": "default", "label": "1"}]}));
        assert!(NotificationPlan::make(&p, 0).is_err());
        assert_eq!(truncate("abcdef", 4), "abc…");
    }

    #[test]
    fn quiet_hours_parse_and_wrap() {
        assert_eq!(QuietHours::parse_hhmm("07:05"), Some(425));
        assert_eq!(QuietHours::parse_hhmm("7:05"), None);
        assert_eq!(QuietHours::parse_hhmm("24:00"), None);
        let q = QuietHours::new("22:00", "07:00").unwrap();
        assert!(q.contains(23 * 60) && q.contains(60) && !q.contains(12 * 60));
        assert!(!QuietHours::new("08:00", "08:00").unwrap().contains(480));
    }

    #[test]
    fn custom_category_is_stable() {
        let a = vec![ActionPlan::button("x", "X", false)];
        let id = custom_category_id(&a);
        assert!(id.starts_with("psyche.custom.") && id.len() == "psyche.custom.".len() + 16);
        assert_eq!(id, custom_category_id(&a));
        assert_eq!(category_for(default_buttons(NotificationKind::System)).identifier, "psyche.open");
    }

    #[test]
    fn args_round_trip() {
        let info = UserInfo {
            notification_id: "apr_01:x".into(),
            kind: "approval".into(),
            approval_id: Some("apr_01".into()),
            require_biometry: true,
            destructive_action_ids: vec!["deny".into()],
            presence_challenge: Some("0f".repeat(32)),
        };
        let s = encode_args(&info, "approve");
        let (back, action) = decode_args(&s).unwrap();
        assert_eq!(back, info);
        assert_eq!(action, "approve");
        assert!(back.needs_authentication("approve"));
        assert!(!back.needs_authentication("deny"));
        assert!(!back.needs_authentication("default"));
        assert!(decode_args("v=2&n=x&a=y").is_none());
        assert!(decode_args("garbage").is_none());
    }

    #[test]
    fn toast_xml_escapes_and_wires_actions() {
        let p = show(json!({"id": "n1", "kind": "approval", "title": "Pay <Bob> & co", "body": "\"quoted\"", "requireBiometry": true}));
        let plan = NotificationPlan::make(&p, 0).unwrap();
        let x = toast_xml(&plan);
        assert!(x.contains("<text>Pay &lt;Bob&gt; &amp; co</text>"));
        assert!(x.contains("&quot;quoted&quot;"));
        assert!(x.contains("scenario=\"reminder\""));
        assert!(x.contains("content=\"Deny\"") && x.contains("hint-buttonStyle=\"Critical\""));
        assert!(x.contains("arguments=\"v=1&amp;n=n1&amp;a=approve"));
        let p = show(json!({"id": "n2", "kind": "input_needed", "title": "Q", "body": "b"}));
        let x = toast_xml(&NotificationPlan::make(&p, 0).unwrap());
        assert!(x.contains("<input id=\"reply\" type=\"text\" placeHolderContent=\"Type your answer\"/>"));
        assert!(x.contains("hint-inputId=\"reply\""));
        assert!(!x.contains("scenario="));
        let p = show(json!({"id": "n3", "kind": "briefing", "title": "Q", "body": "b"}));
        assert!(toast_xml(&NotificationPlan::make(&p, 0).unwrap()).contains("<audio silent=\"true\"/>"));
    }

    #[test]
    fn response_payload_shape() {
        let mut r = NotificationResponse::new("n1", "reply", Some("hi".into()), Some("apr".into()));
        r.presence = Some(PresenceSignature { signature: "sig".into(), key_id: "kid".into() });
        let p = r.payload();
        assert_eq!(p["type"], "notify.response");
        assert_eq!(p["text"], "hi");
        assert_eq!(p["replyText"], "hi");
        assert_eq!(p["presence"], json!({"signature": "sig", "keyId": "kid"}));
        assert!(p.get("authError").is_none());
    }

    #[test]
    fn long_ids_get_a_short_stable_tag() {
        assert_eq!(tag_for("short"), "short");
        let long = "a".repeat(100);
        assert_eq!(tag_for(&long).len(), 64);
        assert_eq!(tag_for(&long), tag_for(&long));
    }
}
