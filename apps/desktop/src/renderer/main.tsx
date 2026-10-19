import { ShellApp } from "@psyche/web/shell";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { desktopPlatform } from "./bridge.ts";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <ShellApp platform={desktopPlatform()} />
  </StrictMode>,
);
