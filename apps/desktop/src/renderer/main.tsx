import { PsycheApp } from "@psyche/web/compose";
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
if (hud) {
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
}
createRoot(root).render(
  <StrictMode>{hud ? <DictationHud /> : <PsycheApp platform={desktopPlatform()} />}</StrictMode>,
);
