//! The `psyche-machine:v1` link and the origin rules behind it, a port of
//! `packages/protocol/src/machine-link.ts` (and `lan-address.ts`). Both sides are tested against
//! the shared vectors in `packages/protocol/test/vectors/machine-link.json`.
//!
//! Strict on purpose: another version, another field, a duplicate key, a missing one or a value of
//! the wrong shape is refused, and a Gateway origin is accepted only when it is already written
//! the way `URL.origin` writes it. A link is an invitation, never authority: the owner's approval
//! on the Gateway is what makes this computer a machine.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

pub const MACHINE_LINK_PREFIX: &str = "psyche-machine:v1:";
const MAX_LINK_LENGTH: usize = 2048;
const MAX_URL_LENGTH: usize = 300;
const MAX_NAME_LENGTH: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MachineLink {
    /// `https://host[:port]`, canonical.
    pub gateway_url: String,
    /// base64url raw Ed25519 key of the Gateway identity.
    pub gateway_key: String,
    /// LAN only: base64url SHA-256 of the Gateway certificate's SPKI.
    pub cert_pin: Option<String>,
    pub setup_token: String,
    pub host_name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    NotAMachineLink,
    UnsupportedVersion,
    Malformed,
    ExtraFields,
    BadField,
}

impl Problem {
    pub fn as_str(self) -> &'static str {
        match self {
            Problem::NotAMachineLink => "not_a_machine_link",
            Problem::UnsupportedVersion => "unsupported_version",
            Problem::Malformed => "malformed",
            Problem::ExtraFields => "extra_fields",
            Problem::BadField => "bad_field",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkError {
    pub problem: Problem,
    pub field: Option<String>,
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.field {
            Some(field) => write!(f, "machine link: {} ({field})", self.problem.as_str()),
            None => write!(f, "machine link: {}", self.problem.as_str()),
        }
    }
}

impl std::error::Error for LinkError {}

fn err(problem: Problem) -> LinkError {
    LinkError {
        problem,
        field: None,
    }
}

fn bad(field: &str) -> LinkError {
    LinkError {
        problem: Problem::BadField,
        field: Some(field.to_string()),
    }
}

// ---------------------------------------------------------------------------------------------
// Hosts

fn parse_ipv4(text: &str) -> Option<[u8; 4]> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, part) in parts.iter().enumerate() {
        let ok = !part.is_empty()
            && part.len() <= 3
            && part.bytes().all(|b| b.is_ascii_digit())
            && (*part == "0" || !part.starts_with('0'));
        if !ok {
            return None;
        }
        out[i] = part
            .parse::<u16>()
            .ok()
            .and_then(|n| u8::try_from(n).ok())?;
    }
    Some(out)
}

/// Eight 16-bit groups of an IPv6 literal without brackets, or `None`.
fn parse_ipv6(text: &str) -> Option<[u16; 8]> {
    if text.is_empty()
        || text
            .bytes()
            .any(|b| !(b.is_ascii_hexdigit() || b == b':' || b == b'.'))
    {
        return None;
    }
    let halves: Vec<&str> = text.split("::").collect();
    if halves.len() > 2 {
        return None;
    }
    fn groups(side: &str) -> Option<Vec<u16>> {
        if side.is_empty() {
            return Some(vec![]);
        }
        let parts: Vec<&str> = side.split(':').collect();
        let mut out = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            if part.contains('.') {
                if i != parts.len() - 1 {
                    return None;
                }
                let v4 = parse_ipv4(part)?;
                out.push(u16::from(v4[0]) * 256 + u16::from(v4[1]));
                out.push(u16::from(v4[2]) * 256 + u16::from(v4[3]));
            } else {
                if part.is_empty() || part.len() > 4 {
                    return None;
                }
                out.push(u16::from_str_radix(part, 16).ok()?);
            }
        }
        Some(out)
    }
    let head = groups(halves[0])?;
    let tail = if halves.len() == 2 {
        groups(halves[1])?
    } else {
        vec![]
    };
    let full: Vec<u16> = if halves.len() == 1 {
        if head.len() != 8 {
            return None;
        }
        head
    } else {
        let missing = 8usize.checked_sub(head.len() + tail.len())?;
        if missing < 1 {
            return None;
        }
        let mut all = head;
        all.extend(std::iter::repeat_n(0u16, missing));
        all.extend(tail);
        all
    };
    full.try_into().ok()
}

/// How the WHATWG URL parser writes an IPv6 host (lowercase, compressed longest zero run of two
/// or more groups, the first on a tie).
fn serialize_ipv6(groups: &[u16; 8]) -> String {
    let (mut best_start, mut best_len) = (usize::MAX, 0usize);
    let mut i = 0;
    while i < 8 {
        if groups[i] == 0 {
            let start = i;
            while i < 8 && groups[i] == 0 {
                i += 1;
            }
            if i - start > best_len {
                best_start = start;
                best_len = i - start;
            }
        } else {
            i += 1;
        }
    }
    if best_len < 2 {
        best_start = usize::MAX;
    }
    let mut out = String::new();
    let mut i = 0;
    while i < 8 {
        if i == best_start {
            out.push_str(if i == 0 { "::" } else { ":" });
            i += best_len;
            continue;
        }
        out.push_str(&format!("{:x}", groups[i]));
        if i != 7 {
            out.push(':');
        }
        i += 1;
    }
    out
}

fn is_mdns_label(label: &str) -> bool {
    let b = label.as_bytes();
    !b.is_empty()
        && b.len() <= 63
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && b[0] != b'-'
        && b[b.len() - 1] != b'-'
}

#[derive(Debug, PartialEq, Eq)]
enum LanKind {
    Mdns,
    Ipv4Private,
    Ipv6UniqueLocal,
}

fn lan_host_kind(host: &str) -> Option<LanKind> {
    let lower = host.trim().to_ascii_lowercase();
    let h = lower.strip_suffix('.').unwrap_or(&lower);
    if h.is_empty() || h.len() > 253 || h.contains('%') {
        return None;
    }
    let bracketed = h.starts_with('[') && h.ends_with(']');
    let bare = if bracketed { &h[1..h.len() - 1] } else { h };
    if bracketed || bare.contains(':') {
        let groups = parse_ipv6(bare)?;
        return (groups[0] & 0xfe00 == 0xfc00).then_some(LanKind::Ipv6UniqueLocal);
    }
    if bare.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        let v4 = parse_ipv4(bare)?;
        let private = v4[0] == 10
            || (v4[0] == 172 && (16..=31).contains(&v4[1]))
            || (v4[0] == 192 && v4[1] == 168);
        return private.then_some(LanKind::Ipv4Private);
    }
    let name = bare.strip_suffix(".local")?;
    name.split('.').all(is_mdns_label).then_some(LanKind::Mdns)
}

fn is_local_suffix_host(host: &str) -> bool {
    let lower = host.trim().to_ascii_lowercase();
    lower
        .strip_suffix('.')
        .unwrap_or(&lower)
        .ends_with(".local")
}

/// Hosts a CA-certified (no `certPin`) Gateway can never be.
fn is_non_public_host(hostname: &str) -> bool {
    let h = hostname.to_ascii_lowercase();
    if h.ends_with('.') {
        return true;
    }
    if h == "localhost" || h.ends_with(".localhost") || h == "localhost.localdomain" {
        return true;
    }
    if is_local_suffix_host(&h) || lan_host_kind(&h).is_some() {
        return true;
    }
    let bare = if h.starts_with('[') && h.ends_with(']') {
        &h[1..h.len() - 1]
    } else {
        &h[..]
    };
    if bare.contains(':') {
        let Some(g) = parse_ipv6(bare) else {
            return true;
        };
        let (first, second) = (g[0], g[1]);
        return g[..4].iter().all(|x| *x == 0)
            || (first == 0x64 && second == 0xff9b)
            || first == 0x2002
            || (first == 0x2001 && (second == 0 || second == 0x0db8))
            || (first == 0x100 && second == 0 && g[2] == 0 && g[3] == 0)
            || first & 0xffc0 == 0xfe80
            || first & 0xffc0 == 0xfec0
            || first & 0xff00 == 0xff00;
    }
    if bare.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        let Some(v4) = parse_ipv4(bare) else {
            return true;
        };
        let (a, b, c) = (v4[0], v4[1], v4[2]);
        return a == 0
            || a == 127
            || a >= 224
            || (a == 169 && b == 254)
            || (a == 100 && (64..=127).contains(&b))
            || (a == 198 && (b == 18 || b == 19))
            || (a == 192 && b == 0 && c == 2)
            || (a == 198 && b == 51 && c == 100)
            || (a == 203 && b == 0 && c == 113);
    }
    !h.contains('.')
        || h.ends_with(".internal")
        || h.ends_with(".home.arpa")
        || h == "home.arpa"
        || h.ends_with(".lan")
        || h.ends_with(".corp")
        || h.ends_with(".home")
}

/// A DNS host name written the way a URL writes it: lowercase ASCII labels, and not a name the
/// URL parser would read as an IPv4 address (last label all digits).
fn is_canonical_dns_name(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    if !labels.iter().all(|l| is_mdns_label(l)) {
        return false;
    }
    let last = labels[labels.len() - 1];
    !last.bytes().all(|b| b.is_ascii_digit())
}

/// A parsed Gateway origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Origin {
    /// Host as a URL writes it: lowercase name, dotted IPv4 or `[ipv6]`.
    pub host: String,
    pub port: Option<u16>,
}

impl Origin {
    pub fn https(&self) -> String {
        match self.port {
            Some(p) => format!("https://{}:{p}", self.host),
            None => format!("https://{}", self.host),
        }
    }

    pub fn host_for_connect(&self) -> &str {
        self.host.trim_start_matches('[').trim_end_matches(']')
    }

    pub fn port_or_default(&self) -> u16 {
        self.port.unwrap_or(443)
    }
}

fn unsafe_char(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{200b}'..='\u{200f}'
        | '\u{2028}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
}

/// The origin exactly as `URL.origin` writes it (one optional final `/` is dropped), or `None`.
/// With `lan` the host must be a local-network one, without it a public name or address.
pub fn canonical_gateway_origin(text: &str, lan: bool) -> Option<Origin> {
    if text.is_empty()
        || text.chars().count() > MAX_URL_LENGTH
        || text.chars().any(|c| unsafe_char(c) || c.is_whitespace())
        || text.contains(['?', '#', '%', '\\'])
    {
        return None;
    }
    let rest = text.strip_prefix("https://")?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    if rest.is_empty() || rest.contains(['/', '@']) {
        return None;
    }
    let (host, port) = if let Some(after) = rest.strip_prefix('[') {
        let close = after.find(']')?;
        let inner = &after[..close];
        let tail = &after[close + 1..];
        let groups = parse_ipv6(inner)?;
        // The literal must already be the canonical spelling.
        if serialize_ipv6(&groups) != inner {
            return None;
        }
        let port = match tail {
            "" => None,
            t => Some(t.strip_prefix(':')?),
        };
        (format!("[{inner}]"), port)
    } else {
        let (host, port) = match rest.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        };
        let ok_host = if host.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            parse_ipv4(host).is_some()
        } else {
            is_canonical_dns_name(host)
        };
        if !ok_host {
            return None;
        }
        (host.to_string(), port)
    };
    let port = match port {
        None => None,
        Some(p) => {
            let valid = !p.is_empty()
                && p.len() <= 5
                && p.bytes().all(|b| b.is_ascii_digit())
                && (p == "0" || !p.starts_with('0'));
            if !valid {
                return None;
            }
            let n: u32 = p.parse().ok()?;
            // 0 is refused, 443 is the default port that `URL.origin` leaves out.
            if n == 0 || n > 65535 || n == 443 {
                return None;
            }
            Some(n as u16)
        }
    };
    if host.ends_with('.') {
        return None;
    }
    if lan {
        lan_host_kind(&host)?;
    } else if is_non_public_host(&host) {
        return None;
    }
    Some(Origin { host, port })
}

// ---------------------------------------------------------------------------------------------
// Fields

pub fn is_base64url_32_bytes(text: &str) -> bool {
    text.len() == 43
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        && URL_SAFE_NO_PAD
            .decode(text)
            .map(|b| b.len() == 32)
            .unwrap_or(false)
}

pub fn is_setup_token(text: &str) -> bool {
    text.strip_prefix("pst_").is_some_and(|rest| {
        rest.len() == 43
            && rest
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    })
}

/// Characters a name may never contain (the `BAD_NAME_CHARS` of `schemas/machines.ts`, plus the
/// astral ranges its pattern lists).
pub fn bad_name_char(c: char) -> bool {
    let n = c as u32;
    matches!(n,
        0x00..=0x1f | 0x7f..=0x9f | 0xad | 0x34f | 0x600..=0x605 | 0x61c | 0x6dd | 0x70f
        | 0x890 | 0x891 | 0x8e2 | 0x115f | 0x1160 | 0x17b4 | 0x17b5 | 0x180b..=0x180f
        | 0x200b..=0x200f | 0x2028..=0x202e | 0x2060..=0x206f | 0x3164 | 0xfe00..=0xfe0f
        | 0xfeff | 0xffa0 | 0xfff0..=0xfffb | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x202f
        | 0x205f | 0x2800 | 0x3000 | 0xfffc
        | 0xe0000..=0xe0fff | 0x110bd | 0x110cd | 0x1d173..=0x1d17a | 0x1bca0..=0x1bca3
        | 0x13430..=0x1343f)
}

/// A name fit for a prompt or a card: 1 to 64 characters (UTF-16 units, as the TS side counts),
/// no hidden or control text, no leading or trailing space.
pub fn name_ok(name: &str) -> bool {
    let units = name.encode_utf16().count();
    (1..=MAX_NAME_LENGTH).contains(&units)
        && !name.chars().any(bad_name_char)
        && name.trim() == name
        && !name.trim().is_empty()
}

fn clean_host_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

// ---------------------------------------------------------------------------------------------
// Parsing

/// Rejects duplicate keys at the top level, as `serde_json::Value` would keep the last silently.
struct StrictMap(Vec<(String, Value)>);

impl<'de> Deserialize<'de> for StrictMap {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = StrictMap;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<StrictMap, A::Error> {
                let mut out: Vec<(String, Value)> = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, Value>()? {
                    if out.iter().any(|(seen, _)| *seen == k) {
                        return Err(serde::de::Error::custom("duplicate key"));
                    }
                    out.push((k, v));
                }
                Ok(StrictMap(out))
            }
        }
        d.deserialize_map(V)
    }
}

const REQUIRED: [&str; 4] = ["gatewayUrl", "gatewayKey", "setupToken", "hostName"];
const ALL: [&str; 5] = [
    "gatewayUrl",
    "gatewayKey",
    "certPin",
    "setupToken",
    "hostName",
];

/// Parses a pasted link. Surrounding whitespace is ignored and the scheme is matched without
/// regard to case; the rest is exact.
pub fn parse_machine_link(input: &str) -> Result<MachineLink, LinkError> {
    let text = input.trim();
    if text.chars().count() > MAX_LINK_LENGTH {
        return Err(err(Problem::Malformed));
    }
    const SCHEME: &str = "psyche-machine:";
    if text.len() < SCHEME.len()
        || !text.is_char_boundary(SCHEME.len())
        || !text[..SCHEME.len()].eq_ignore_ascii_case(SCHEME)
    {
        return Err(err(Problem::NotAMachineLink));
    }
    let rest = &text[SCHEME.len()..];
    let Some((version, encoded)) = rest.split_once(':') else {
        return Err(err(Problem::Malformed));
    };
    if version != "v1" {
        return Err(err(Problem::UnsupportedVersion));
    }
    if encoded.is_empty()
        || encoded.len() % 4 == 1
        || !encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(err(Problem::Malformed));
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| err(Problem::Malformed))?;
    let body = String::from_utf8(bytes).map_err(|_| err(Problem::Malformed))?;
    let value: Value = serde_json::from_str(&body).map_err(|_| err(Problem::Malformed))?;
    if !value.is_object() {
        return Err(err(Problem::Malformed));
    }
    let StrictMap(entries) = serde_json::from_str(&body).map_err(|_| err(Problem::Malformed))?;
    if let Some((extra, _)) = entries.iter().find(|(k, _)| !ALL.contains(&k.as_str())) {
        return Err(LinkError {
            problem: Problem::ExtraFields,
            field: Some(extra.clone()),
        });
    }
    let get = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    for field in REQUIRED {
        if !get(field).is_some_and(Value::is_string) {
            return Err(bad(field));
        }
    }
    let cert_pin = match get("certPin") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return Err(bad("certPin")),
    };
    let s = |key: &str| get(key).and_then(Value::as_str).unwrap_or_default();
    let lan = cert_pin.is_some();
    let origin = canonical_gateway_origin(s("gatewayUrl"), lan).ok_or_else(|| bad("gatewayUrl"))?;
    if !is_base64url_32_bytes(s("gatewayKey")) {
        return Err(bad("gatewayKey"));
    }
    if let Some(pin) = &cert_pin {
        if !is_base64url_32_bytes(pin) {
            return Err(bad("certPin"));
        }
    }
    if !is_setup_token(s("setupToken")) {
        return Err(bad("setupToken"));
    }
    let host_name = s("hostName");
    if host_name.encode_utf16().count() > MAX_NAME_LENGTH
        || host_name
            .chars()
            .any(|c| unsafe_char(c) || bad_name_char(c))
        || clean_host_name(host_name).is_empty()
    {
        return Err(bad("hostName"));
    }
    Ok(MachineLink {
        gateway_url: origin.https(),
        gateway_key: s("gatewayKey").to_string(),
        cert_pin,
        setup_token: s("setupToken").to_string(),
        host_name: clean_host_name(host_name),
    })
}

/// The Gateway named on the command line without a link: `wss://host[:port][/ws]`. A public,
/// CA-certified name only: a LAN Gateway has no certificate a CA vouches for, so it needs a link
/// with its `certPin`.
pub fn parse_gateway_url(text: &str) -> Result<Origin, String> {
    let refuse = |why: &str| Err(format!("{text}: {why}"));
    let Some(rest) = text.strip_prefix("wss://") else {
        return refuse("a Gateway address starts with wss://");
    };
    let rest = rest
        .strip_suffix("/ws")
        .or_else(|| rest.strip_suffix('/'))
        .unwrap_or(rest);
    match canonical_gateway_origin(&format!("https://{rest}"), false) {
        Some(origin) => Ok(origin),
        None => refuse(
            "must be a public host name or address with no path, query, credentials or \
             default port; for a Gateway on this network use the link from Settings",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn vectors() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../packages/protocol/test/vectors/machine-link.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("shared vectors {}: {e}", path.display()));
        serde_json::from_str(&text).unwrap()
    }

    fn link_of(case: &Value, consts: &Value) -> String {
        let fill = |t: &str| {
            t.replace("$KEY", consts["KEY"].as_str().unwrap())
                .replace("$TOKEN", consts["TOKEN"].as_str().unwrap())
                .replace("$PIN", consts["PIN"].as_str().unwrap())
        };
        let body = match case.get("body") {
            Some(b) => fill(b.as_str().unwrap()),
            None => {
                let mut o = serde_json::Map::new();
                o.insert("gatewayUrl".into(), case["url"].clone());
                o.insert("gatewayKey".into(), consts["KEY"].clone());
                if case.get("pin").and_then(Value::as_bool) == Some(true) {
                    o.insert("certPin".into(), consts["PIN"].clone());
                }
                o.insert("setupToken".into(), consts["TOKEN"].clone());
                o.insert("hostName".into(), json_str("H"));
                serde_json::to_string(&Value::Object(o)).unwrap()
            }
        };
        format!("{MACHINE_LINK_PREFIX}{}", URL_SAFE_NO_PAD.encode(body))
    }

    fn json_str(s: &str) -> Value {
        Value::String(s.into())
    }

    #[test]
    fn every_shared_vector_agrees_with_the_typescript_parser() {
        let v = vectors();
        let cases = v["cases"].as_array().unwrap();
        assert!(cases.len() >= 90);
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let result = parse_machine_link(&link_of(case, &v["constants"]));
            match case["expect"].as_str().unwrap() {
                "accept" => {
                    let got = result.unwrap_or_else(|e| panic!("{label}: {e}"));
                    assert_eq!(
                        got.gateway_url,
                        case["gatewayUrl"].as_str().unwrap(),
                        "{label}"
                    );
                    assert_eq!(
                        got.cert_pin.is_some(),
                        case.get("pin").and_then(Value::as_bool) == Some(true),
                        "{label}"
                    );
                }
                _ => {
                    let e = result
                        .err()
                        .unwrap_or_else(|| panic!("{label}: must be refused"));
                    if let Some(problem) = case.get("problem").and_then(Value::as_str) {
                        assert_eq!(e.problem.as_str(), problem, "{label}");
                    }
                }
            }
        }
    }

    fn good_body() -> String {
        let v = vectors();
        let c = &v["constants"];
        format!(
            r#"{{"gatewayUrl":"https://a.ts.net","gatewayKey":"{}","setupToken":"{}","hostName":"Studio Mac"}}"#,
            c["KEY"].as_str().unwrap(),
            c["TOKEN"].as_str().unwrap()
        )
    }

    fn link(body: &str) -> String {
        format!("{MACHINE_LINK_PREFIX}{}", URL_SAFE_NO_PAD.encode(body))
    }

    #[test]
    fn a_good_link_parses_and_the_scheme_is_case_insensitive_and_trimmed() {
        let l = link(&good_body());
        let parsed = parse_machine_link(&format!("  {l}\n")).unwrap();
        assert_eq!(parsed.gateway_url, "https://a.ts.net");
        assert_eq!(parsed.host_name, "Studio Mac");
        let upper = l.replacen("psyche-machine", "PSYCHE-Machine", 1);
        assert!(parse_machine_link(&upper).is_ok());
    }

    #[test]
    fn the_other_link_schemes_and_versions_are_refused() {
        let body = URL_SAFE_NO_PAD.encode(good_body());
        for (text, problem) in [
            (format!("psyche-pair:v1:{body}"), Problem::NotAMachineLink),
            (format!("psyche-pair:v2:{body}"), Problem::NotAMachineLink),
            (
                format!("psyche-machine:v2:{body}"),
                Problem::UnsupportedVersion,
            ),
            ("psyche-machine:v1".to_string(), Problem::Malformed),
            ("psyche-machine:v1:".to_string(), Problem::Malformed),
            ("psyche-machine:v1:!!!!".to_string(), Problem::Malformed),
            (String::new(), Problem::NotAMachineLink),
            ("https://a.ts.net".to_string(), Problem::NotAMachineLink),
        ] {
            assert_eq!(
                parse_machine_link(&text).unwrap_err().problem,
                problem,
                "{text}"
            );
        }
    }

    #[test]
    fn an_over_long_link_is_refused() {
        let long = format!("{MACHINE_LINK_PREFIX}{}", "A".repeat(2100));
        assert_eq!(
            parse_machine_link(&long).unwrap_err().problem,
            Problem::Malformed
        );
    }

    #[test]
    fn names_follow_the_machine_name_rule() {
        for ok in ["lab-box", "Büro PC", "日本語のPC", "a"] {
            assert!(name_ok(ok), "{ok}");
        }
        for bad in [
            "",
            " lab",
            "lab ",
            "lab\nbox",
            "lab\u{202e}box",
            "lab\u{200b}box",
            "lab\u{2800}box",
            "lab\u{e0041}box",
            "lab\u{a0}box",
            &"x".repeat(65),
        ] {
            assert!(!name_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn gateway_urls_without_a_link_are_public_wss_names_only() {
        assert_eq!(
            parse_gateway_url("wss://studio-mac.tail1234.ts.net")
                .unwrap()
                .https(),
            "https://studio-mac.tail1234.ts.net"
        );
        assert_eq!(
            parse_gateway_url("wss://a.ts.net:8443/ws").unwrap().https(),
            "https://a.ts.net:8443"
        );
        for bad in [
            "ws://a.ts.net",
            "https://a.ts.net",
            "wss://user@a.ts.net",
            "wss://a.ts.net/other",
            "wss://a.ts.net/ws?x=1",
            "wss://localhost",
            "wss://192.168.1.4",
            "wss://studio.local",
            "wss://A.ts.net",
            "wss://a.ts.net:443",
            "wss://",
        ] {
            assert!(parse_gateway_url(bad).is_err(), "{bad}");
        }
    }
}
