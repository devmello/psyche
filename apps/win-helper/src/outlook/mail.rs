//! Pure pieces of the mail adapter (ports of `MailWave1` plus the Outlook-specific filter and
//! body helpers). No COM here: every rule is unit-tested.

use std::collections::HashSet;

use serde_json::{Value, json};

use super::ids::ItemId;
use super::model::{Destination, MailDraft, MailDraftRecord, MailFilter, text};
use crate::node::capability::{CapabilityError, ErrorCode};
use crate::node::encoding::sha256_hex;

pub const MAX_BATCH: usize = 100;
pub const MAX_ATTACHMENTS: usize = 50;

/// The role of a mailbox from its (leaf) name, as providers name them (`MailWave1.special`).
pub fn special(name: &str) -> Option<&'static str> {
    let leaf = name.rsplit('/').next().unwrap_or(name).to_lowercase();
    match leaf.as_str() {
        "inbox" => Some("inbox"),
        "sent" | "sent messages" | "sent items" | "sent mail" => Some("sent"),
        "drafts" => Some("drafts"),
        "junk" | "spam" | "junk e-mail" | "junk email" => Some("junk"),
        "trash" | "deleted items" | "deleted messages" | "bin" => Some("trash"),
        "archive" | "all mail" => Some("archive"),
        _ => None,
    }
}

/// Message ids for a batch: 1–100 Outlook item ids, duplicates dropped (`MailWave1.batch`).
pub fn batch(ids: &[String], field: &str) -> Result<Vec<ItemId>, CapabilityError> {
    if ids.is_empty() || ids.len() > MAX_BATCH {
        return Err(CapabilityError::invalid_params(
            format!("{field} takes 1–{MAX_BATCH} message ids"),
            Some(field),
        ));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for s in ids {
        let id = ItemId::decode(s, field)?;
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    Ok(out)
}

/// SHA-256 of the body with line endings normalized and the ends trimmed (`MailWave1.bodyHash`).
pub fn body_hash(body: &str) -> String {
    let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
    sha256_hex(normalized.trim().as_bytes())
}

fn addresses(xs: &[String]) -> Vec<String> {
    let mut v: Vec<String> = xs.iter().map(|a| a.trim().to_lowercase()).collect();
    v.sort();
    v
}

/// What the approval covered (`MailDraftExpectation`).
#[derive(Debug, Clone, PartialEq)]
pub struct DraftExpectation {
    pub to: Vec<String>,
    pub cc: Option<Vec<String>>,
    pub subject: String,
    pub body_sha256: String,
}

/// `binding_mismatch` / `draft_changed` naming what changed since the approval.
pub fn check(draft: &MailDraftRecord, e: &DraftExpectation) -> Result<(), CapabilityError> {
    let mut changed: Vec<&str> = Vec::new();
    if addresses(&draft.to) != addresses(&e.to) {
        changed.push("to");
    }
    match &e.cc {
        Some(cc) if addresses(&draft.cc) != addresses(cc) => changed.push("cc"),
        None if !draft.cc.is_empty() => changed.push("cc"),
        _ => {}
    }
    if draft.subject != e.subject {
        changed.push("subject");
    }
    if draft.body_sha256 != e.body_sha256.to_lowercase() {
        changed.push("body");
    }
    if changed.is_empty() {
        return Ok(());
    }
    Err(CapabilityError::new(
        ErrorCode::BindingMismatch,
        "draft_changed",
        format!(
            "The draft changed after it was approved ({}). Approve the new version.",
            changed.join(", ")
        ),
    )
    .with_detail("changed", json!(changed)))
}

fn is_address(a: &str) -> bool {
    a.chars().count() <= 320
        && a.contains('@')
        && !a
            .chars()
            .any(|c| c == '\n' || c == '\r' || c == ',' || c == ';')
}

/// `checkDraft`: 1–50 to, ≤ 50 cc, each one address; subject ≤ 500, body ≤ 100 000.
pub fn check_draft(d: &MailDraft) -> Result<(), CapabilityError> {
    let cc = d.cc.as_deref().unwrap_or_default();
    if !(1..=50).contains(&d.to.len()) || cc.len() > 50 {
        return Err(CapabilityError::invalid_params(
            "1–50 recipients in to, at most 50 in cc",
            Some("to"),
        ));
    }
    if !d.to.iter().chain(cc).all(|a| is_address(a)) {
        return Err(CapabilityError::invalid_params(
            "each recipient is one email address",
            Some("to"),
        ));
    }
    text(Some(&d.subject), 500, "subject", false)?;
    text(Some(&d.body), 100_000, "body", false)
}

/// `checkAddresses`: `min`–50 addresses.
pub fn check_addresses(xs: &[String], field: &str, min: usize) -> Result<(), CapabilityError> {
    if xs.len() < min || xs.len() > 50 {
        return Err(CapabilityError::invalid_params(
            format!("{field} takes {min}–50 addresses"),
            Some(field),
        ));
    }
    if !xs.iter().all(|a| is_address(a)) {
        return Err(CapabilityError::invalid_params(
            "each recipient is one email address",
            Some(field),
        ));
    }
    Ok(())
}

/// `AppleMailMoveParams.to`: "archive" / "junk", or {mailbox, account}.
pub fn destination(to: Option<&Value>) -> Result<Destination, CapabilityError> {
    if let Some(s) = to.and_then(Value::as_str) {
        return match s {
            "archive" => Ok(Destination::Archive),
            "junk" => Ok(Destination::Junk),
            _ => Err(CapabilityError::invalid_params(
                "to is archive, junk or {mailbox, account} (deleting is a separate capability)",
                Some("to"),
            )),
        };
    }
    let field = |k: &str| {
        to.and_then(|v| v.get(k))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    match (field("mailbox"), field("account")) {
        (Some(name), Some(account)) => Ok(Destination::Mailbox { name, account }),
        _ => Err(CapabilityError::invalid_params(
            "to is archive, junk or {mailbox, account}",
            Some("to"),
        )),
    }
}

/// Names Windows refuses as file names (with or without an extension).
const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i + 1..]),
        _ => (name, ""),
    }
}

/// A file name for an attachment saved among `existing` names (`MailWave1.fileName`, plus what
/// Windows forbids): no path separators or `<>:"|?*`, no control or format characters, no
/// leading dot, no trailing dot or space, no reserved device names, at most 200 characters, and
/// unique case-insensitively (`name (2).pdf`).
pub fn file_name(raw: &str, existing: &HashSet<String>) -> String {
    let mapped: String = raw
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
                || c.is_control()
                || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut name = mapped
        .trim()
        .trim_start_matches('.')
        .trim_end_matches(['.', ' '])
        .to_owned();
    if name.is_empty() {
        name = "attachment".into();
    }
    if RESERVED.contains(&split_ext(&name).0.to_lowercase().as_str()) {
        name = format!("_{name}");
    }
    if name.chars().count() > 200 {
        let (base, ext) = split_ext(&name);
        name = if ext.is_empty() || ext.chars().count() > 20 {
            name.chars().take(200).collect()
        } else {
            let keep = 200 - ext.chars().count() - 1;
            format!("{}.{ext}", base.chars().take(keep).collect::<String>())
        };
    }
    let lower: HashSet<String> = existing.iter().map(|s| s.to_lowercase()).collect();
    if !lower.contains(&name.to_lowercase()) {
        return name;
    }
    let (base, ext) = split_ext(&name);
    let (base, ext) = (base.to_owned(), ext.to_owned());
    (2..)
        .map(|n| {
            if ext.is_empty() {
                format!("{base} ({n})")
            } else {
                format!("{base} ({n}).{ext}")
            }
        })
        .find(|c| !lower.contains(&c.to_lowercase()))
        .unwrap_or_default()
}

/// A DASL string literal: single quotes doubled, `%` (LIKE's wildcard) and line breaks dropped.
pub fn dasl_literal(s: &str) -> String {
    s.chars()
        .filter(|c| *c != '%' && *c != '\r' && *c != '\n')
        .collect::<String>()
        .replace('\'', "''")
}

const SUBJECT: &str = "\"http://schemas.microsoft.com/mapi/proptag/0x0037001F\"";
const SENDER_NAME: &str = "\"http://schemas.microsoft.com/mapi/proptag/0x0C1A001F\"";
const SENDER_EMAIL: &str = "\"http://schemas.microsoft.com/mapi/proptag/0x0C1F001F\"";
const SENDER_SMTP: &str = "\"http://schemas.microsoft.com/mapi/proptag/0x5D01001F\"";
const RECEIVED: &str = "\"urn:schemas:httpmail:datereceived\"";
const READ: &str = "\"urn:schemas:httpmail:read\"";

fn sender_like(v: &str) -> String {
    format!(
        "{SENDER_NAME} LIKE '%{v}%' OR {SENDER_EMAIL} LIKE '%{v}%' OR {SENDER_SMTP} LIKE '%{v}%'"
    )
}

/// The `Items.Restrict` DASL filter for `mail.search`, or None to take the folder as it is.
/// `date` formats a UTC instant as Outlook parses DASL dates (UTC, the user's locale format).
pub fn dasl_filter(f: &MailFilter, date: &dyn Fn(i64) -> String) -> Option<String> {
    let mut clauses: Vec<String> = Vec::new();
    let q = dasl_literal(f.query.trim());
    if !q.is_empty() {
        clauses.push(format!("({SUBJECT} LIKE '%{q}%' OR {})", sender_like(&q)));
    }
    let from = dasl_literal(f.from.trim());
    if !from.is_empty() {
        clauses.push(format!("({})", sender_like(&from)));
    }
    match f.unread {
        Some(true) => clauses.push(format!("{READ} = 0")),
        Some(false) => clauses.push(format!("{READ} = 1")),
        None => {}
    }
    if let Some(s) = f.since {
        clauses.push(format!("{RECEIVED} >= '{}'", date(s)));
    }
    if let Some(u) = f.until {
        clauses.push(format!("{RECEIVED} < '{}'", date(u)));
    }
    (!clauses.is_empty()).then(|| format!("@SQL={}", clauses.join(" AND ")))
}

/// `from` as Mail shows it: `Name <address>`, either part alone when the other is missing.
pub fn sender(name: &str, address: &str) -> String {
    let (n, a) = (name.trim(), address.trim());
    match (n.is_empty(), a.is_empty() || !a.contains('@')) {
        (false, false) if !n.eq_ignore_ascii_case(a) => format!("{n} <{a}>"),
        (_, false) => a.to_owned(),
        _ => n.to_owned(),
    }
}

/// A folder's `FolderPath` (`\\Store name\Inbox\Receipts`) as a mailbox name
/// (`Inbox/Receipts`, the mac helper's `Parent/Child`).
pub fn mailbox_path(folder_path: &str) -> String {
    let p = folder_path.trim_start_matches('\\');
    match p.find('\\') {
        Some(i) => p[i + 1..].replace('\\', "/"),
        None => String::new(),
    }
}

/// Mail's flag index (0 red, 1 orange, 2 yellow, 3 green, 4 blue, 5 purple, 6 gray) → Outlook's
/// `FlagIcon` (olPurpleFlagIcon 1, Orange 2, Green 3, Yellow 4, Blue 5, Red 6; no gray: red).
pub fn flag_icon(color: u8) -> i32 {
    match color {
        1 => 2,
        2 => 4,
        3 => 3,
        4 => 5,
        5 => 1,
        _ => 6,
    }
}

/// Newest first by the `date` field (ISO strings sort as they read).
pub fn newest_first(xs: &mut [super::model::MailSummaryRecord]) {
    xs.sort_by(|a, b| b.date.cmp(&a.date));
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Plain text → HTML paragraphs (escaped, line breaks kept).
pub fn text_to_html(t: &str) -> String {
    t.replace("\r\n", "\n")
        .split('\n')
        .map(|l| {
            let e = escape_html(l);
            format!(
                "<div>{}</div>",
                if e.is_empty() { "<br>".into() } else { e }
            )
        })
        .collect()
}

/// Puts `text` above the quoted message of a reply / forward. HTML bodies get it right after the
/// opening `<body …>` tag (or at the start when there is none); plain bodies get it plus a blank
/// line.
pub fn insert_on_top(body: &str, html: bool, text: &str) -> String {
    if text.trim().is_empty() {
        return body.to_owned();
    }
    if !html {
        return format!(
            "{}\r\n\r\n{body}",
            text.replace("\r\n", "\n").replace('\n', "\r\n")
        );
    }
    let lower = body.to_lowercase();
    let at = lower
        .find("<body")
        .and_then(|i| body[i..].find('>').map(|j| i + j + 1))
        .unwrap_or(0);
    format!(
        "{}{}<div><br></div>{}",
        &body[..at],
        text_to_html(text),
        &body[at..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(to: &[&str], cc: &[&str], subject: &str, body: &str) -> MailDraftRecord {
        MailDraftRecord::new(
            "d".into(),
            subject.into(),
            to.iter().map(|s| s.to_string()).collect(),
            cc.iter().map(|s| s.to_string()).collect(),
            body.into(),
        )
    }

    #[test]
    fn special_names() {
        assert_eq!(special("Inbox"), Some("inbox"));
        assert_eq!(special("Sent Items"), Some("sent"));
        assert_eq!(special("Deleted Items"), Some("trash"));
        assert_eq!(special("Junk Email"), Some("junk"));
        assert_eq!(special("Projects/Archive"), Some("archive"));
        assert_eq!(special("Projects"), None);
    }

    #[test]
    fn body_hash_normalizes_line_endings() {
        assert_eq!(body_hash("a\r\nb\r\n"), body_hash("a\nb"));
        assert_eq!(body_hash("a\rb"), body_hash("a\nb"));
        assert_ne!(body_hash("a b"), body_hash("ab"));
        assert_eq!(body_hash("").len(), 64);
    }

    #[test]
    fn binding_check_names_what_changed() {
        let d = draft(&["A@x.com"], &[], "Hi", "Body\r\n");
        let ok = DraftExpectation {
            to: vec!["a@x.com ".into()],
            cc: None,
            subject: "Hi".into(),
            body_sha256: body_hash("Body").to_uppercase(),
        };
        assert!(check(&d, &ok).is_ok());
        let mut bad = ok.clone();
        bad.subject = "Hey".into();
        bad.to = vec!["b@x.com".into()];
        let e = check(&d, &bad).unwrap_err();
        assert_eq!(e.code, ErrorCode::BindingMismatch);
        assert_eq!(e.reason, "draft_changed");
        assert_eq!(e.details["changed"], json!(["to", "subject"]));
        // cc on the draft that the approval did not cover.
        let d2 = draft(&["a@x.com"], &["c@x.com"], "Hi", "Body");
        assert_eq!(
            check(&d2, &ok).unwrap_err().details["changed"],
            json!(["cc"])
        );
    }

    #[test]
    fn batches_dedupe_and_validate() {
        let id = ItemId::new("AABB", "CCDD").encode();
        assert_eq!(batch(&[id.clone(), id.clone()], "ids").unwrap().len(), 1);
        assert!(batch(&[], "ids").is_err());
        assert!(batch(&["123".into()], "ids").is_err());
        assert!(batch(&vec![id; 101], "ids").is_err());
    }

    #[test]
    fn drafts_and_addresses_validate() {
        let d = |to: Vec<&str>| MailDraft {
            to: to.into_iter().map(String::from).collect(),
            cc: None,
            subject: "s".into(),
            body: "b".into(),
        };
        assert!(check_draft(&d(vec!["a@x.com"])).is_ok());
        assert!(check_draft(&d(vec![])).is_err());
        assert!(check_draft(&d(vec!["a@x.com, b@x.com"])).is_err());
        assert!(check_draft(&d(vec!["nobody"])).is_err());
        assert!(check_addresses(&[], "cc", 0).is_ok());
        assert!(check_addresses(&[], "to", 1).is_err());
    }

    #[test]
    fn destinations() {
        assert_eq!(
            destination(Some(&json!("archive"))).unwrap(),
            Destination::Archive
        );
        assert_eq!(
            destination(Some(&json!("junk"))).unwrap(),
            Destination::Junk
        );
        assert!(destination(Some(&json!("trash"))).is_err());
        assert_eq!(
            destination(Some(&json!({"mailbox": "Receipts", "account": "me@x.com"}))).unwrap(),
            Destination::Mailbox {
                name: "Receipts".into(),
                account: "me@x.com".into()
            }
        );
        assert!(destination(Some(&json!({"mailbox": "Receipts"}))).is_err());
        assert!(destination(None).is_err());
    }

    #[test]
    fn file_names_are_safe_on_windows_and_unique() {
        let none = HashSet::new();
        assert_eq!(file_name("../../etc/passwd", &none), "_.._etc_passwd");
        assert_eq!(file_name("a:b*c?.pdf", &none), "a_b_c_.pdf");
        assert_eq!(file_name("...", &none), "attachment");
        assert_eq!(file_name("CON.txt", &none), "_CON.txt");
        assert_eq!(file_name("report. ", &none), "report");
        assert_eq!(file_name("x\u{202E}fdp.exe", &none), "x_fdp.exe");
        let long = format!("{}.pdf", "a".repeat(300));
        let n = file_name(&long, &none);
        assert_eq!(n.chars().count(), 200);
        assert!(n.ends_with(".pdf"));
        let existing: HashSet<String> = ["Bill.pdf".to_string(), "bill (2).PDF".to_string()].into();
        assert_eq!(file_name("bill.pdf", &existing), "bill (3).pdf");
    }

    #[test]
    fn dasl_filters() {
        let date = |ms: i64| format!("D{ms}");
        assert_eq!(dasl_filter(&MailFilter::default(), &date), None);
        let f = MailFilter {
            query: "it's 100%".into(),
            unread: Some(true),
            since: Some(5),
            until: Some(9),
            from: "bob".into(),
        };
        let s = dasl_filter(&f, &date).unwrap();
        assert!(s.starts_with("@SQL=("));
        assert!(s.contains("LIKE '%it''s 100%'"), "{s}");
        assert!(s.contains("\"urn:schemas:httpmail:read\" = 0"));
        assert!(s.contains(">= 'D5'") && s.contains("< 'D9'"));
        assert!(s.contains("LIKE '%bob%'"));
        assert_eq!(s.matches(" AND ").count(), 4);
    }

    #[test]
    fn folder_paths_and_flag_icons() {
        assert_eq!(
            mailbox_path(r"\\Mailbox - Ann Lee\Inbox\Receipts"),
            "Inbox/Receipts"
        );
        assert_eq!(mailbox_path(r"\\ann@x.com\Inbox"), "Inbox");
        assert_eq!(mailbox_path(r"\\ann@x.com"), "");
        assert_eq!(flag_icon(0), 6);
        assert_eq!(flag_icon(5), 1);
        assert_eq!(flag_icon(6), 6);
    }

    #[test]
    fn senders_and_bodies() {
        assert_eq!(sender("Bob", "bob@x.com"), "Bob <bob@x.com>");
        assert_eq!(sender("", "bob@x.com"), "bob@x.com");
        assert_eq!(sender("Bob", "/O=EXCH/CN=BOB"), "Bob");
        assert_eq!(sender("bob@x.com", "bob@x.com"), "bob@x.com");
        assert_eq!(
            insert_on_top("quoted", false, "Hi\nthere"),
            "Hi\r\nthere\r\n\r\nquoted"
        );
        let h = insert_on_top("<html><BODY class=x><p>q</p></body></html>", true, "a<b");
        assert_eq!(
            h,
            "<html><BODY class=x><div>a&lt;b</div><div><br></div><p>q</p></body></html>"
        );
        assert_eq!(
            insert_on_top("<p>q</p>", true, "x"),
            "<div>x</div><div><br></div><p>q</p>"
        );
        assert_eq!(insert_on_top("q", true, "  "), "q");
    }
}
