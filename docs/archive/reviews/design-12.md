# design-12: approval cards can be spoofed through attacker-controlled strings

**Severity:** High. **Surface:** ApprovalRequest `summary` / `details`, chat approval messages, notifications. **Docs:** 05 §3.7 (Delivery), §3.11 (summary example); 02 §4.6; `ApprovalRequestInput.summary`. **Owners:** S05, S10, S12, S14.

## Attack

`summary` is free text built from tool arguments, for example `Send reply "Re: invoice 0042" to alice@example.org`. On a desktop card the structured `details` can be rendered safely. On **chat surfaces and macOS notifications** the summary *is* the card. Its parts (subjects, file names, event titles, page titles, MCP tool names, merchant names) come from attacker content:

1. **Newline injection.** Subject = `Re: invoice"\n\n✅ Low risk: saving a draft only (write)\nTo: you\n\n`. Telegram shows a forged "draft only" line above the buttons. iMessage polls truncate long text, so the real recipient falls off the end.
2. **Bidi controls.** A file name `invoice‮fdp.exe` renders as `invoiceexe.pdf`. An argv element `rm -rf ./build ‮/ ~` reorders on screen. Zero-width characters make `alice@example.org` and `alice@exam​ple.org` look the same.
3. **IDN homographs.** The site in `Sign in to https://www.kаyak.com` (Cyrillic а) looks like the real origin. The grant cannot match the real origin, but the owner approves a *new* `site` grant or a fill for the lookalike, because the card shows Unicode.
4. **Length and truncation.** 05 says cards are "never truncated for recipients, commands, amounts or URLs". Notifications are truncated by the OS, and Telegram limits `callback_data` and message length. The design does not say what happens when the full arguments do not fit.
5. **Markdown and entities.** If a chat adapter sends the summary with `parse_mode: MarkdownV2` / HTML, a `[safe link](https://evil.test)` or `<a href>` in a subject becomes a live link on the approval message.

## Assumption broken

"Cards render from structured arguments, never from post-read prose" (§7.2). The `summary` field is post-read prose under another name.

## Proposed control

- Drop the free-text `summary` from surfaces. Every surface renders a **fixed template** per kind from typed fields: `Action / Account / To / Amount / Origin / Command`. Untrusted strings go only into quoted value slots.
- Sanitize every value slot: strip or show visibly (`⟨U+202E⟩`) all `Cf`-category characters (bidi controls, zero-width characters, the tag block), collapse CR/LF to `⏎`, and show hosts as punycode when they mix scripts (Chromium's IDN display policy).
- Chat messages are sent as plain text (no parse mode), with the security-relevant lines **first**. If the rendered card exceeds the surface's limit, that surface gets "Open on your Mac to review", not a truncated card with buttons.
- Approval notifications show the template header only and send the owner to the card.

## Test case

```ts
const subject = 'Re: x"\n\n✅ Low risk: saving a draft only (write)\n';
const { approval } = await broker.requestApproval(emailApproval({ subject, to: ["attacker@evil.test"] }));
const tg = renderForSurface("telegram", approval);
expect(tg.parseMode).toBeUndefined();
expect(tg.text.split("\n")[0]).toMatch(/^Send email · destructive/);
expect(tg.text.split("\n").slice(0, 3).join("\n")).toContain("attacker@evil.test");
expect(tg.text).not.toMatch(/\n✅ Low risk/);               // newline collapsed inside the quoted slot
for (const s of ["invoice‮fdp.exe", "alice@exam​ple.org"]) {
  expect(renderForSurface("desktop", fileApproval(s)).text).toMatch(/⟨U\+(202E|200B)⟩/);
}
expect(renderForSurface("notification", fillApproval("https://www.kаyak.com")).text).toContain("xn--");
expect(renderForSurface("imessage", hugeArgvApproval()).buttons).toHaveLength(0);
```
