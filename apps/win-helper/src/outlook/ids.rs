//! Stable ids for Outlook items and folders.
//!
//! Outlook identifies an item by its `EntryID` within a store (`StoreID`), both hex strings. The
//! wire id packs both, base64url, behind a version prefix:
//!
//! - item: `ol1.<store>.<entry>` and, for one occurrence of a recurring series,
//!   `ol1.<store>.<entry>.<start>` (`start` = the occurrence's start, Unix seconds UTC; the
//!   series master's `EntryID` is shared by all its occurrences);
//! - folder (calendar, reminders list, contacts folder): `olf1.<store>.<entry>`.
//!
//! An `EntryID` survives renames, edits and Outlook restarts. It changes when an item moves to
//! another store, and on Exchange when it moves between folders (`mail.move` returns counts only,
//! like the mac helper; search again for new ids).

use crate::node::capability::CapabilityError;
use crate::node::encoding::{b64url, b64url_decode};

const ITEM_PREFIX: &str = "ol1";
const FOLDER_PREFIX: &str = "olf1";
/// Exchange store ids run to a few hundred bytes; anything far longer is not ours.
pub const MAX_ID_LENGTH: usize = 4_000;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ItemId {
    /// `StoreID`, upper-case hex.
    pub store: String,
    /// `EntryID`, upper-case hex.
    pub entry: String,
    /// One occurrence of a recurring series: its start (Unix seconds, UTC).
    pub occurrence: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FolderId {
    pub store: String,
    pub entry: String,
}

fn hex_to_bytes(h: &str) -> Option<Vec<u8>> {
    if h.is_empty() || h.len() % 2 != 0 {
        return None;
    }
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(h.get(i..i + 2)?, 16).ok())
        .collect()
}

fn bytes_to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect()
}

fn pack(hex: &str) -> String {
    b64url(&hex_to_bytes(hex).unwrap_or_default())
}

fn unpack(part: &str) -> Option<String> {
    let bytes = b64url_decode(part)?;
    (!bytes.is_empty()).then(|| bytes_to_hex(&bytes))
}

fn invalid(field: &str, what: &str) -> CapabilityError {
    CapabilityError::invalid_params(format!("{field} is {what}"), Some(field))
}

impl ItemId {
    pub fn new(store: &str, entry: &str) -> Self {
        ItemId {
            store: store.to_ascii_uppercase(),
            entry: entry.to_ascii_uppercase(),
            occurrence: None,
        }
    }

    pub fn with_occurrence(mut self, start_secs: Option<i64>) -> Self {
        self.occurrence = start_secs;
        self
    }

    /// The series (or plain item) this id names, without an occurrence.
    pub fn series(&self) -> ItemId {
        ItemId {
            occurrence: None,
            ..self.clone()
        }
    }

    pub fn encode(&self) -> String {
        let mut s = format!("{ITEM_PREFIX}.{}.{}", pack(&self.store), pack(&self.entry));
        if let Some(o) = self.occurrence {
            s.push('.');
            s.push_str(&o.to_string());
        }
        s
    }

    /// Parses a wire id, or `invalid_params` naming `field`.
    pub fn decode(s: &str, field: &str) -> Result<ItemId, CapabilityError> {
        let what = "an Outlook item id (from a list, search or read)";
        if s.len() > MAX_ID_LENGTH {
            return Err(invalid(field, what));
        }
        let parts: Vec<&str> = s.split('.').collect();
        if !(3..=4).contains(&parts.len()) || parts[0] != ITEM_PREFIX {
            return Err(invalid(field, what));
        }
        let store = unpack(parts[1]).ok_or_else(|| invalid(field, what))?;
        let entry = unpack(parts[2]).ok_or_else(|| invalid(field, what))?;
        let occurrence = match parts.get(3) {
            Some(o) => Some(o.parse::<i64>().map_err(|_| invalid(field, what))?),
            None => None,
        };
        Ok(ItemId {
            store,
            entry,
            occurrence,
        })
    }
}

impl FolderId {
    pub fn new(store: &str, entry: &str) -> Self {
        FolderId {
            store: store.to_ascii_uppercase(),
            entry: entry.to_ascii_uppercase(),
        }
    }

    pub fn encode(&self) -> String {
        format!(
            "{FOLDER_PREFIX}.{}.{}",
            pack(&self.store),
            pack(&self.entry)
        )
    }

    pub fn decode(s: &str, field: &str) -> Result<FolderId, CapabilityError> {
        let what = "an Outlook folder id (from list_calendars / list_lists)";
        if s.len() > MAX_ID_LENGTH {
            return Err(invalid(field, what));
        }
        let parts: Vec<&str> = s.split('.').collect();
        if parts.len() != 3 || parts[0] != FOLDER_PREFIX {
            return Err(invalid(field, what));
        }
        Ok(FolderId {
            store: unpack(parts[1]).ok_or_else(|| invalid(field, what))?,
            entry: unpack(parts[2]).ok_or_else(|| invalid(field, what))?,
        })
    }
}

/// Decodes a list of folder ids (`calendarIds`, `listIds`).
pub fn folder_ids(
    xs: &Option<Vec<String>>,
    field: &str,
) -> Result<Option<Vec<FolderId>>, CapabilityError> {
    match xs {
        None => Ok(None),
        Some(v) => v
            .iter()
            .map(|s| FolderId::decode(s, field))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const STORE: &str = "0000000038A1BB1005E5101AA1BB08002B2A56C20000454D534D44422E444C4C";
    const ENTRY: &str = "00000000A1B2C3D4E5F60718293A4B5C6D7E8F900700";

    #[test]
    fn item_ids_round_trip() {
        let id = ItemId::new(STORE, &ENTRY.to_lowercase());
        assert_eq!(id.entry, ENTRY, "upper-cased");
        let s = id.encode();
        assert!(s.starts_with("ol1."));
        assert!(!s.contains('='), "unpadded base64url");
        assert_eq!(ItemId::decode(&s, "id").unwrap(), id);
        let occ = id.clone().with_occurrence(Some(1_792_843_200));
        let s2 = occ.encode();
        assert!(s2.ends_with(".1792843200"));
        let back = ItemId::decode(&s2, "id").unwrap();
        assert_eq!(back.occurrence, Some(1_792_843_200));
        assert_eq!(back.series(), id);
        // Shorter than the two hex strings side by side.
        assert!(s.len() < STORE.len() + ENTRY.len());
    }

    #[test]
    fn folder_ids_round_trip_and_are_distinct() {
        let f = FolderId::new(STORE, ENTRY);
        let s = f.encode();
        assert!(s.starts_with("olf1."));
        assert_eq!(FolderId::decode(&s, "calendarId").unwrap(), f);
        assert!(
            ItemId::decode(&s, "id").is_err(),
            "a folder id is not an item id"
        );
        assert!(FolderId::decode(&ItemId::new(STORE, ENTRY).encode(), "x").is_err());
    }

    #[test]
    fn bad_ids_are_invalid_params_naming_the_field() {
        for bad in [
            "",
            "123",
            "ol1.",
            "ol1.!!.AA",
            "ol1.AA.BB.x",
            "ol2.AA.BB",
            "ol1.AA.BB.1.2",
        ] {
            let e = ItemId::decode(bad, "ids").unwrap_err();
            assert_eq!(e.reason, "invalid_params", "{bad}");
            assert_eq!(e.details["field"], "ids");
        }
        assert!(ItemId::decode(&"a".repeat(MAX_ID_LENGTH + 1), "id").is_err());
    }

    #[test]
    fn folder_id_lists() {
        let f = FolderId::new(STORE, ENTRY).encode();
        assert_eq!(folder_ids(&None, "x").unwrap(), None);
        assert_eq!(folder_ids(&Some(vec![f]), "x").unwrap().unwrap().len(), 1);
        assert!(folder_ids(&Some(vec!["nope".into()]), "calendarIds").is_err());
    }
}
