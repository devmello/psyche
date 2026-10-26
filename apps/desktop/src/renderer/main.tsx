import {
  PsycheApp,
  SCREEN_ASK_REGION_ROUTE,
  SCREEN_ASK_ROUTE,
  ScreenAsk,
  type ScreenAskBridge,
  ScreenAskRegion,
} from "@psyche/web/compose";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { desktopPlatform } from "./bridge.ts";
import { DictationHud } from "./dictation-hud.tsx";
import "../compose/app.css";

// A file dropped outside the composer must never navigate the app view (security §12).
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
// The dictation HUD panel runs the same renderer at its own route (src/main/dictation/hud.ts).
const hud = window.location.pathname === "/dictation-hud";
// Ask about my screen (docs/design/screen-ask-2026.md): the ask panel and its region overlay.
const screenAsk = window.location.pathname === SCREEN_ASK_ROUTE;
const screenAskRegion = window.location.pathname === SCREEN_ASK_REGION_ROUTE;
const screenAskBridge = (window.psyche as { screenAsk?: ScreenAskBridge }).screenAsk;
if (hud || screenAsk || screenAskRegion) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}
createRoot(root).render(
  <StrictMode>
    {hud ? (
      <DictationHud />
    ) : screenAsk ? (
      <ScreenAsk
        platform={desktopPlatform()}
        {...(screenAskBridge ? { bridge: screenAskBridge } : {})}
      />
    ) : screenAskRegion ? (
      <ScreenAskRegion {...(screenAskBridge ? { bridge: screenAskBridge } : {})} />
    ) : (
      <PsycheApp platform={desktopPlatform()} />
    )}
  </StrictMode>,
);
