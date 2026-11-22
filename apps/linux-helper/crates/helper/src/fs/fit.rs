//! Text that must fit in one frame once it is JSON (#1512 review r1, finding 3): a frame is at
//! most `MAX_FRAME_BYTES` (1 MiB) on the wire, and JSON writes a control character as six bytes
//! (`\u0000`), so a cap on raw bytes is not a cap on the result. These cut text by its encoded
//! size, at a character boundary.

/// What `serde_json` writes for one character.
pub fn encoded_len(c: char) -> usize {
    match c {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if (c as u32) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

/// `s` cut so its JSON string body is at most `budget` bytes, and whether anything was cut.
pub fn fit_str(s: &str, budget: usize) -> (String, bool) {
    let mut used = 0usize;
    for (i, c) in s.char_indices() {
        let n = encoded_len(c);
        if used + n > budget {
            return (s[..i].to_string(), true);
        }
        used += n;
    }
    (s.to_string(), false)
}

/// The longest prefix of `bytes` whose text (invalid sequences as U+FFFD) fits in `budget`
/// encoded bytes: the text and how many input bytes it covers. A character cut off by the end
/// of `bytes` is left for the next read, unless `at_end` says nothing follows it.
pub fn fit_utf8(bytes: &[u8], budget: usize, at_end: bool) -> (String, usize) {
    let mut out = String::new();
    let mut used = 0usize;
    let mut at = 0usize;
    while at < bytes.len() {
        let rest = &bytes[at..];
        let (valid, bad) = match std::str::from_utf8(rest) {
            Ok(s) => (s, None),
            Err(e) => (
                // `valid_up_to` ends valid UTF-8, so this never falls back.
                std::str::from_utf8(&rest[..e.valid_up_to()]).unwrap_or(""),
                Some(e.error_len()),
            ),
        };
        for (i, c) in valid.char_indices() {
            let n = encoded_len(c);
            if used + n > budget {
                return (out, at + i);
            }
            used += n;
            out.push(c);
        }
        at += valid.len();
        match bad {
            None => break,
            Some(len) => {
                let len = match len {
                    Some(n) => n,
                    // Cut off by the end of this read.
                    None if !at_end => return (out, at),
                    None => bytes.len() - at,
                };
                if used + 3 > budget {
                    return (out, at);
                }
                used += 3;
                out.push('\u{fffd}');
                at += len;
            }
        }
    }
    (out, at)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json_len(s: &str) -> usize {
        serde_json::to_string(s).unwrap().len() - 2
    }

    #[test]
    fn encoded_lengths_match_serde_json() {
        for s in [
            "a", "\"", "\\", "\n", "\u{0}", "\u{1f}", "\u{7f}", "é", "€", "😀", "\t",
        ] {
            let c = s.chars().next().unwrap();
            assert_eq!(encoded_len(c), json_len(s), "{s:?}");
        }
    }

    #[test]
    fn text_is_cut_by_its_encoded_size() {
        let nul = "\u{0}".repeat(1000);
        let (cut, more) = fit_str(&nul, 600);
        assert!(more);
        assert_eq!(cut.len(), 100);
        assert!(json_len(&cut) <= 600);
        let (all, more) = fit_str("plain", 600);
        assert_eq!((all.as_str(), more), ("plain", false));
        // A multi-byte character is never split.
        let (cut, _) = fit_str("ééé", 5);
        assert_eq!(cut, "éé");
    }

    #[test]
    fn bytes_are_cut_at_a_character_and_report_what_they_cover() {
        let bytes = vec![0u8; 200_000];
        let (text, covered) = fit_utf8(&bytes, 600_000, true);
        assert_eq!(covered, 100_000);
        assert!(json_len(&text) <= 600_000);
        // "é" is two bytes: a read that ends between them leaves it for the next read.
        let (text, covered) = fit_utf8(&[b'a', 0xc3], 100, false);
        assert_eq!((text.as_str(), covered), ("a", 1));
        let (text, covered) = fit_utf8(&[b'a', 0xc3], 100, true);
        assert_eq!((text.as_str(), covered), ("a\u{fffd}", 2));
        // Invalid bytes in the middle become U+FFFD and are covered.
        let (text, covered) = fit_utf8(&[b'a', 0xff, b'b'], 100, false);
        assert_eq!((text.as_str(), covered), ("a\u{fffd}b", 3));
    }
}
