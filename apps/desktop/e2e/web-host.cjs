// Test-only Electron main for the layout spec: opens the built web client (served by the mock
// Gateway at PSYCHE_WEB_URL) in a plain sandboxed window with no preload, so the page runs the
// real web host (createWebPlatform), not the desktop bridge.
const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: Number(process.env.PSYCHE_WEB_WIDTH ?? 390),
    height: Number(process.env.PSYCHE_WEB_HEIGHT ?? 844),
    useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(process.env.PSYCHE_WEB_URL);
});
app.on("window-all-closed", () => app.quit());
