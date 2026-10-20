import { app, Menu, type MenuItemConstructorOptions } from "electron";

/**
 * Application menu. The shell owns most shortcuts (docs/06 §4.11) in the renderer; the menu
 * keeps the standard Edit roles (copy/paste in text fields) and replaces the default ⌘W, which
 * would close the whole window, with a shell command (close the thread view or pop-out).
 */
export interface MenuActions {
  newSideChat(): void;
  palette(): void;
  closeThreadView(): void;
  quitEntirely(): void;
  /** View → Zoom: an appearance setting (`appearance.zoom`), not Electron's per-origin memory. */
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
}

export function buildAppMenu(a: MenuActions): Menu {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        {
          label: "Quit Psyche (tasks keep running)",
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit(),
        },
        { label: "Quit Psyche entirely", accelerator: "CmdOrCtrl+Alt+Q", click: a.quitEntirely },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New side chat", accelerator: "CmdOrCtrl+N", click: a.newSideChat },
        { label: "Close", accelerator: "CmdOrCtrl+W", click: a.closeThreadView },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { label: "Command palette", accelerator: "CmdOrCtrl+K", click: a.palette },
        { type: "separator" },
        { id: "zoom-reset", label: "Actual Size", accelerator: "CmdOrCtrl+0", click: a.zoomReset },
        { id: "zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: a.zoomIn },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: a.zoomIn, visible: false },
        { id: "zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: a.zoomOut },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as MenuItemConstructorOptions]),
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
