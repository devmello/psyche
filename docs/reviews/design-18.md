# design-18: after a fill, the page can echo the secret back in forms the masking does not catch

**Severity:** High. **Surface:** post-fill hygiene, `read_text`, snapshots, screenshots, tab titles, CDP events. **Docs:** 05 §4.7, §7.2 item 7; 02 §8; `CredentialBroker.redact`. **Owners:** S08, S06.

## Attack

After a fill, the page holds the value and **its own JavaScript runs** (page JS is not blocked on third-party origins; only the agent's JS is). The masking replaces exact matches and URL / base64 encodings in `read_text`, snapshots and transcripts, and blacks out the *field's* bounding box in screenshots. The attack needs a page that is hostile or has hostile content: a phishing lookalike that passed a card (design-12), a bound origin with an XSS, or a script on the bound origin from a compromised third party.

The page runs `input.addEventListener("input", e => show(e.target.value))` and renders the value:

- with separators: `h u n t e r 2`, or one character per `<span>`. AX names join them with spaces or newlines, so an exact match fails;
- reversed, hex, or with case swapped;
- in `aria-label`, `title` or `placeholder` of *another* element, which reaches the model through the AX snapshot's `name` / `value`;
- in `document.title`, which becomes `DriverTab.title` and the `PageSnapshot.title`;
- in `alert()` / `confirm()`, which arrive as `DriverEvent {type: "dialog", message}`;
- as large text in a `<canvas>`, so the snapshot is sparse, the model asks for a screenshot, and the text is outside the blacked-out box;
- in the URL fragment (`location.hash = btoa(v.split("").reverse().join(""))`), which reaches the model through `NavigateResult.url` and `navigated` events;
- in `console.log`, if console messages are ever surfaced (S08 debugging).

TOTP values are short (6 digits) and so collide with ordinary page text, so masking them by value is unreliable anyway.

## Assumption broken

The secret stays in the field. Once the value is in the DOM, the page can copy it anywhere, and masking cannot keep up with every encoding.

## Proposed control

- Fill through a path the page cannot read before submit. Use a password-manager-style **"fill at submit"**: the agent fills a dummy, and the broker swaps the real value into the outgoing request in `Fetch.requestPaused` for a form posting to the bound origin. Where that is not possible:
- For the rest of the Task on that tab: no screenshots (refused, not masked); snapshots and `read_text` pass a fuzzy detector (whitespace and separator stripped, case-folded, reversed, hex, base32, base64 with any alignment), and a hit **aborts the tool result** rather than masking it. Titles, dialog messages and URLs pass the same detector. A detector hit audits `credential.echo_detected` and pauses the Task.
- Masking is defined over **normalized** strings (NFKC, strip `Cf` / whitespace) and the page's text is checked once after normalization.
- TOTP: after a TOTP fill, the tab's content is not returned to the model until navigation commits to a different URL.

## Test case

Fixture page `https://login.example.test/` (bound origin) with an input listener that writes the value into: (a) spaced spans, (b) reversed text, (c) `document.title`, (d) `alert()`, (e) a canvas, (f) `location.hash` as reversed base64.

| Agent call after `credentials.request` fills `{{cred:ex-login.password}}` | Expected |
| --- | --- |
| `snapshot` | no ref `name` / `value` contains any normalized form of `FAKE_PW`; or the call fails with `echo_detected` |
| `readText` | same |
| `listTabs` / `snapshot().title` | title masked or call fails |
| `dialog` event | message masked |
| `screenshot` | refused (`post_fill_no_screenshot`) |
| `navigate` result / `navigated` event URL | fragment stripped or masked |
| secret-leak checker over the transcript | 0 hits for `encodingsOf(FAKE_PW)` |
