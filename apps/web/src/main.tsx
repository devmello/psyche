import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PsycheApp } from "./compose/PsycheApp.tsx";
import { createWebPlatform } from "./platform.ts";
import "./compose/app.css";

/**
 * The web client (feature A8): the same composed app the desktop renders (S11's shell with the
 * UI kit's screens), over the browser WebSocket to `location.origin`. Below 720 px the shell
 * switches to the phone layout (docs/06 §3.24).
 */

// A file dropped outside the composer must never navigate the page away from the app.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const platform = createWebPlatform();
createRoot(root).render(
  <StrictMode>
    <PsycheApp platform={platform} />
  </StrictMode>,
);
