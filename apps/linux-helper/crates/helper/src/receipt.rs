//! Receipts for side-effecting capabilities, in the shape the Mac and Windows helpers send:
//! `node.result.receipt` is a full `Receipt` (`rcpt_` id, the capability's receipt kind, the
//! approval id, `ok` | `failed` | `uncertain`, a one-line summary, `externalRefs`, a UTC
//! timestamp). The Gateway adds the task and tool-call ids when it records it, and reads the
//! outcome, summary and refs of this one for the receipt the owner sees, so a click that could
//! not be verified is `uncertain` end to end instead of `ok`.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use psyche_protocol::Receipt;
use serde_json::{json, Map, Value};

/// The node-side half of a `Receipt`.
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptDraft {
    /// `ok` | `failed` | `uncertain`.
    pub outcome: &'static str,
    pub summary: String,
    pub external_refs: Map<String, Value>,
}

impl ReceiptDraft {
    pub fn ok(summary: impl Into<String>) -> Self {
        ReceiptDraft {
            outcome: "ok",
            summary: summary.into(),
            external_refs: Map::new(),
        }
    }

    pub fn failed(summary: impl Into<String>) -> Self {
        ReceiptDraft {
            outcome: "failed",
            summary: summary.into(),
            external_refs: Map::new(),
        }
    }

    /// The full `Receipt` wire object, or `None` if it does not fit the protocol type.
    pub fn wire(&self, kind: &str, approval_id: Option<&str>, now: SystemTime) -> Option<Receipt> {
        let mut random = [0u8; 12];
        getrandom::fill(&mut random).ok()?;
        let mut v = json!({
            "id": format!("rcpt_{}", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random)),
            "kind": kind,
            "outcome": self.outcome,
            "summary": self.summary.chars().take(500).collect::<String>(),
            "externalRefs": Value::Object(self.external_refs.clone()),
            "createdAt": iso8601_millis(now),
        });
        if let Some(a) = approval_id {
            v["approvalId"] = json!(a);
        }
        serde_json::from_value(v).ok()
    }
}

/// `2026-11-04T10:00:00.123Z`.
pub fn iso8601_millis(t: SystemTime) -> String {
    let ms = match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_millis()).unwrap_or(i64::MAX),
        Err(e) => -i64::try_from(e.duration().as_millis()).unwrap_or(i64::MAX),
    };
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, mo, d) = civil_from_days(days);
    format!(
        "{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn timestamps_are_utc_with_milliseconds() {
        assert_eq!(iso8601_millis(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso8601_millis(UNIX_EPOCH + Duration::from_millis(1_000_000_000_123)),
            "2001-09-09T01:46:40.123Z"
        );
        // A leap day and a year boundary.
        assert_eq!(
            iso8601_millis(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00.000Z"
        );
        assert_eq!(
            iso8601_millis(UNIX_EPOCH + Duration::from_secs(1_767_225_599)),
            "2025-12-31T23:59:59.000Z"
        );
    }

    #[test]
    fn a_receipt_has_the_fields_the_mac_helper_sends() {
        let mut d = ReceiptDraft {
            outcome: "uncertain",
            summary: "click in Text Editor: unverified".into(),
            external_refs: Map::new(),
        };
        d.external_refs
            .insert("app".into(), json!("org.gnome.texteditor"));
        let r = d
            .wire("computer_action", Some("apr_1"), UNIX_EPOCH)
            .expect("fits the protocol type");
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["id"].as_str().unwrap().starts_with("rcpt_"));
        assert_eq!(v["kind"], "computer_action");
        assert_eq!(v["approvalId"], "apr_1");
        assert_eq!(v["outcome"], "uncertain");
        assert_eq!(v["summary"], "click in Text Editor: unverified");
        assert_eq!(v["externalRefs"]["app"], "org.gnome.texteditor");
        assert_eq!(v["createdAt"], "1970-01-01T00:00:00.000Z");
        // Two receipts never share an id.
        let b = ReceiptDraft::ok("x")
            .wire("computer_action", None, UNIX_EPOCH)
            .unwrap();
        let a = ReceiptDraft::ok("x")
            .wire("computer_action", None, UNIX_EPOCH)
            .unwrap();
        assert_ne!(
            serde_json::to_value(&a).unwrap()["id"],
            serde_json::to_value(&b).unwrap()["id"]
        );
    }
}
