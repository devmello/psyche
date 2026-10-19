import { PsycheApp } from "@psyche/web/compose";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { desktopPlatform } from "./bridge.ts";
import "../compose/app.css";

// A file dropped outside the composer must never navigate the app view (security §12).
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <PsycheApp platform={desktopPlatform()} />
  </StrictMode>,
);
