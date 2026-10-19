import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createWebPlatform } from "./platform.ts";
import { ShellApp } from "./shell/ShellApp.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
const platform = createWebPlatform();
createRoot(root).render(
  <StrictMode>
    <ShellApp platform={platform} />
  </StrictMode>,
);
