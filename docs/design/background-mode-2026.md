# Background mode (no window open → out of the Dock and ⌘-Tab)

Owner request, 2026-10-28: with no Psyche window open it should leave the Dock and ⌘-Tab and just run in the background; opening it again (menu-bar icon, Finder, Spotlight) brings the main window back.

## Behaviour

- The windows that keep Psyche in the Dock: the main window (visible or minimized), Settings, pane pop-outs. The menu-bar panel, screen-ask panel and region overlay, quick-entry bar and dictation HUD do not count.
- When the last one closes or hides, after 150 ms (so a window closing as another opens never flashes the icon), the app switches to the macOS `accessory` activation policy. The tray, the global shortcuts, the Gateway link and notifications keep working.
- Every path that shows a window (`showMain`, `showSettings`, `popOut`) first switches back to `regular`, shows the window, then calls `app.focus({ steal: true })`, but only when the switch happened, so an already-regular app never steals focus. Tray "Open Psyche", `activate` (Finder/Spotlight relaunch), `second-instance`, notification clicks, deep links and shell commands all end in `showMain`.
- Closing the main window still hides it (the agent browser's tab views live in it), so its bounds are kept, and the 10-minute renderer release (#930) is unchanged. ⌘Q sets the quitting flag first, so windows closing on quit never touch the policy. ⌘H keeps the icon until the app is unhidden.
- Setting `appearance.showInDock` ("Show in Dock when no windows are open", Settings → Appearance, default off): on, the icon stays as before.

Code: `apps/desktop/src/main/dock-policy.ts`, wired through `windows.ts` (`dock` option) and `main.ts`. `test/main/activation-policy.test.ts` keeps `setActivationPolicy` out of every other file.

## Not verifiable without the packaged app

Focus after the `accessory` → `regular` switch, the screen-ask panel taking key focus in accessory mode, and notification delivery for an accessory app are macOS behaviours the mocked Electron tests cannot show.
