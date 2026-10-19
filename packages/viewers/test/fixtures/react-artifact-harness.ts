/** Browser harness for the Chrome test: the app side of a React artifact (Sandpack client). */
import { mountReactArtifact } from "../../src/react/sandpack.ts";

declare global {
  interface Window {
    events: { kind: string; value: string }[];
    loads: number;
    messages: { origin: string; fromFrame: boolean; data: unknown }[];
    mountArtifact(source: string, bundlerUrl: string): Promise<string>;
    updateArtifact(source: string): void;
  }
}

window.events = [];
window.loads = 0;
window.messages = [];
addEventListener("message", (e) => {
  const frame = document.querySelector("iframe");
  window.messages.push({
    origin: e.origin,
    fromFrame: e.source === frame?.contentWindow,
    data: e.data,
  });
});
window.mountArtifact = async (source, bundlerUrl) => {
  const frame = document.createElement("iframe");
  frame.style.cssText = "width:600px;height:300px;border:0";
  document.body.appendChild(frame);
  frame.addEventListener("load", () => {
    if (frame.getAttribute("src") !== null) window.loads++;
  });
  const handle = await mountReactArtifact(frame, toFiles(source), {
    bundlerUrl,
    onStatus: (s) => window.events.push({ kind: "status", value: s }),
    onError: (m) => window.events.push({ kind: "error", value: m }),
  });
  window.updateArtifact = (next) => handle.update(toFiles(next));
  return handle.channel;
};

function toFiles(source: string): Record<string, string> {
  return source.trimStart().startsWith("{")
    ? (JSON.parse(source) as { files: Record<string, string> }).files
    : { "/App.tsx": source };
}
