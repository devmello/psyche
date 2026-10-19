// Minimal Electron window with a form, used to test AX snapshots of Chromium content.
// Run with any Electron binary: <electron> spikes/ax-snapshot/electron-form
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 520, height: 520, title: "AXSnap Form" });
  w.loadFile("index.html");
  w.webContents.on("console-message", (_e, _l, _msg) => {});
});
app.on("window-all-closed", () => app.quit());
