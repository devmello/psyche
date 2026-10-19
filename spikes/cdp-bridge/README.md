# Spike 01: Electron CDP bridge

This is a throwaway prototype for `prompts/spike-01-cdp-bridge.md`. The findings are in [`docs/spikes/spike-01-cdp-bridge.md`](../../docs/spikes/spike-01-cdp-bridge.md).

## Run

```bash
cd spikes/cdp-bridge && npm install && npm start
```

`npm start` (`run.mjs`) does four things:

1. It launches Electron 44.9.0 with `main.mjs`.
2. It waits for the bridge socket.
3. It runs `client.mjs` as a separate plain Node process. The client runs every experiment.
4. It quits the app.

Output goes to `.out/` (gitignored):

- `results.json`
- `snapshots/*.txt` (only the fixture snapshot is committed; real-site dumps stay local)
- `frames/*.jpg`
- `quarantine/`
- `inline-pdf.png`

`CDP_BRIDGE_THROTTLE=1 npm start` repeats the run with Chromium's default background throttling, for comparison. That run writes `results-throttled.json`. `node run.mjs --keep-open` leaves the window open after the client finishes. The runs used for the write-up are copied to `results/`.

Network access is needed for the five real pages: Hacker News, Wikipedia, BBC News, GitHub and MDN. Everything else is served by local fixtures (`fixtures.mjs`).

## Files

| File | Process | What it does |
| --- | --- | --- |
| `main.mjs` | Electron main | Builds a `BaseWindow` with a sidebar and two `WebContentsView` tabs in `persist:agent-spike`, with `webContents.debugger` attached to each tab. Runs the NDJSON Unix-socket server and the take-control arbitration. Implements `setWindowOpenHandler` (popups adopted as tabs) and `will-download` (quarantine). |
| `sidebar.html`, `sidebar-preload.cjs` | sidebar renderer | Shows the tab list, an agent/you pill, and the Take control / Release buttons. |
| `bridge-client.mjs` | external Node | The socket client (request/response correlation and event waits). |
| `snapshot.mjs` | external Node | Builds a pruned AX snapshot with stable `ref_N` ids and boxes from `Accessibility.getFullAXTree` and `DOMSnapshot.captureSnapshot`. Also has click-by-ref and type-by-ref. |
| `client.mjs` | external Node | Runs the experiments and measurements. |
| `fixtures.mjs` | external Node | Local HTTP pages: login form, OAuth-style popup, PDF downloads, typing pad, animation. |

## Frame format (spike)

Frames are newline-delimited JSON, one frame per line.

- Request: `{id, tabId?, method, params?, sessionId?}`
- Response: `{id, result}` or `{id, error: {code, message}}`
- Event: `{tabId, method, params, sessionId?}`

Methods named `Bridge.*` are handled by the desktop. Everything else is passed to `webContents.debugger.sendCommand` unchanged. Error codes: `USER_IN_CONTROL`, `DETACHED`, `NO_TAB`, `CDP_ERROR`, `BAD_FRAME`.

The write-up maps this format onto the wire spec v1 from S00.

## What is not production-grade

- No handshake or peer-credential check. The only protection is socket mode 0600.
- No method allowlist.
- No origin policy.
- `Bridge.simulateUser` stands in for a human by calling `sendInputEvent`. Real HID input was not driven.
