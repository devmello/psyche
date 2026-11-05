/**
 * Dev-only preview of the composed app without a Gateway (`pnpm --filter @psyche/web dev`, then
 * http://127.0.0.1:5173/dev/preview.html). The kit's MockGateway answers with the fixture world,
 * and query flags fake what the desktop host would set, so platform layouts can be checked in a
 * browser:
 *
 * - `platform=windows|macos`: `<html data-platform>`, as the desktop renderer sets it;
 * - `chrome=overlay|inset`: the window frame (Windows caption buttons are drawn as a stand-in
 *   strip at the top right, since a browser has no title-bar overlay);
 * - `material=mica`: the Mica flag (a gradient stands in for the desktop wallpaper behind it);
 * - `onboarding=1`: start in onboarding instead of the main chat;
 * - `apps=1`: the host has a permissions port and a paired helper (desktop-only rows show).
 *
 * Never part of a build: vite only serves it in dev.
 */
import { normalizePlatform, setUiPlatform } from "@psyche/ui";
import { MockGateway } from "@psyche/ui/testing";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createFixtureWorld,
  FIXTURE_NOW,
  windowsDevices,
  windowsNodes,
} from "../../../packages/ui/src/fixtures/index.ts";
import { ONBOARDED_KEY, PsycheApp } from "../src/compose/PsycheApp.tsx";
import type { ShellPlatform, WindowChrome } from "../src/shell/platform.ts";
import { browserStorage } from "../src/shell/platform.ts";
import "../src/compose/app.css";

const q = new URLSearchParams(location.search);
const platformFlag = normalizePlatform(q.get("platform"));
if (platformFlag !== undefined) setUiPlatform(platformFlag);
const chromeFlag = q.get("chrome");
const chrome: WindowChrome | undefined =
  chromeFlag === "overlay" || chromeFlag === "inset"
    ? {
        titleBar: chromeFlag,
        ...(chromeFlag === "inset" ? { trafficLights: { x: 18, y: 18 } } : {}),
        ...(q.get("material") === "mica" ? { material: "mica" as const } : {}),
      }
    : undefined;

const world = createFixtureWorld();
if (q.get("onboarding") !== "1") world.settings[ONBOARDED_KEY] = "2026-10-19T09:00:00.000Z";
// `step=safety`: resume onboarding on that step, as saved progress would.
const step = q.get("step");
if (step) world.settings["ui.onboarding.progress"] = { step, done: [] };
// `devices=windows`: this computer is a PC with the Windows helper (fixtures/settings.ts). Needs
// a protocol that lists the `windows` platform and the `win-helper` node kind (results are
// validated against it).
if (q.get("devices") === "windows") {
  world.devices = windowsDevices();
  world.nodes = windowsNodes();
}
const mock = new MockGateway(world, { now: () => FIXTURE_NOW });

const platform: ShellPlatform = {
  kind: chrome ? "desktop" : "web",
  ...(chrome ? { chrome } : {}),
  gateway: {
    getStatus: async () => ({ phase: "paired", health: "ok", attempt: 0 }),
    onStatus: () => () => {},
    // A method the mock lacks rejects, so the screen shows its error state.
    call: (method, params) => mock.request(method as never, params as never),
    onEvent: (cb) => mock.subscribe(cb as never),
    onResync: () => () => {},
    deviceId: async () => world.devices[0]?.id,
  },
  storage: browserStorage(),
  notify: { show: () => {} },
  ...(q.get("apps") === "1"
    ? {
        permissions: {
          status: async () => ({ notifications: "granted", microphone: "denied" }),
          request: async () => "granted",
        },
        helper: {
          getState: async () => ({ kind: "paired" }),
          onState: () => () => {},
          launch: async () => ({ kind: "paired" }),
        },
      }
    : {}),
};

// Stand-ins for what only a desktop window has.
if (chromeFlag === "overlay") {
  const strip = document.createElement("div");
  strip.setAttribute("aria-hidden", "true");
  strip.textContent = "—   ☐   ✕";
  strip.style.cssText =
    "position:fixed;top:0;right:0;width:138px;height:40px;z-index:9999;display:flex;align-items:center;justify-content:center;font:12px 'Segoe UI';color:#555;background:rgb(255 0 0 / 0.12);pointer-events:none;letter-spacing:8px";
  document.body.append(strip);
}
if (q.get("material") === "mica")
  document.documentElement.style.backgroundImage =
    "linear-gradient(135deg, #b9c8e8 0%, #e8d4c8 50%, #c8e0d0 100%)";

// The app routes by path: start on `route=` (default the chat). A reload of that path loads the
// real app, so reopen /dev/preview.html to come back.
history.replaceState(null, "", `${q.get("route") ?? "/chat"}${location.search}`);

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <PsycheApp platform={platform} />
  </StrictMode>,
);
