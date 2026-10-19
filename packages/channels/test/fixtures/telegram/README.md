# Telegram fixtures

Hand-recorded from Bot API 10.x object shapes; no live token used.

- `updates.json`: `Update` objects keyed by scenario (DMs, group mentions, replies with quotes,
  forwards, anonymous admins, edits, media, callback queries, an ignored `channel_post`). The
  `callbackQuery` data is a placeholder the tests replace with a real nonce.
- `responses.json`: raw `ApiResponse` envelopes (`{ ok, result }` / `{ ok: false, error_code, ... }`)
  returned by the test transformer in place of the network.

All ids, file ids and names are invented.
