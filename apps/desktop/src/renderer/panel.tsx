import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QUICK_ENTRY_ROUTE, QuickEntryPanel } from "../compose/QuickEntryPanel.tsx";
import {
  SCREEN_ASK_REGION_ROUTE,
  ScreenAsk,
  type ScreenAskBridge,
  ScreenAskRegion,
} from "../compose/ScreenAsk.tsx";
import { desktopPlatform } from "./bridge.ts";
import { DictationHud } from "./dictation-hud.tsx";
import { loadFirstLocale } from "./preload-locale.ts";
import "../compose/app.css";

// The small always-warm windows (docs/design/lightweight-2026.md): the screen-ask panel, its region
// overlay and the dictation HUD. Their own entry keeps the main app's bundle out of them, so a warm
// panel parses only what it draws. `resolveAppPath` serves panel.html for these routes.

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const hud = window.location.pathname === "/dictation-hud";
const quick = window.location.pathname === QUICK_ENTRY_ROUTE;
const screenAskRegion = window.location.pathname === SCREEN_ASK_REGION_ROUTE;
const screenAskBridge = (window.psyche as { screenAsk?: ScreenAskBridge }).screenAsk;
document.documentElement.style.background = "transparent";
document.body.style.background = "transparent";
void loadFirstLocale().then(() =>
  createRoot(root).render(
    <StrictMode>
      {hud ? (
        <DictationHud />
      ) : quick ? (
        <QuickEntryPanel platform={desktopPlatform()} />
      ) : screenAskRegion ? (
        <ScreenAskRegion {...(screenAskBridge ? { bridge: screenAskBridge } : {})} />
      ) : (
        <ScreenAsk
          platform={desktopPlatform()}
          {...(screenAskBridge ? { bridge: screenAskBridge } : {})}
        />
      )}
    </StrictMode>,
  ),
);
