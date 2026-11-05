import { app, Menu, type MenuItemConstructorOptions } from "electron";

/**
 * Application menu. The shell owns most shortcuts (docs/06 §4.11) in the renderer; the menu
 * keeps the standard Edit roles (copy/paste in text fields) and replaces the default ⌘W, which
 * would close the whole window, with a shell command (close the thread view or pop-out).
 *
 * Windows has no menu bar to show (the hidden title bar draws the shell's own toolbar), but its
 * accelerators work while a Psyche window has focus: `main.ts` sets this menu and hides the bar
 * of each window (`hideMenuBar`). The commands are the same; the keys are Ctrl-based, and "Quit
 * entirely" is Ctrl+Shift+Q, since Ctrl+Alt is AltGr on many keyboards (AltGr+Q types @).
 */
export interface MenuActions {
  newSideChat(): void;
  palette(): void;
  closeThreadView(): void;
  quitEntirely(): void;
  /** Opens the Settings window (⌘,; docs/design/redesign-2026.md §4). */
  settings(): void;
  /** View → Zoom: an appearance setting (`appearance.zoom`), not Electron's per-origin memory. */
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
}

function viewMenu(
  a: MenuActions,
  fullScreen: MenuItemConstructorOptions,
): MenuItemConstructorOptions {
  return {
    label: "View",
    submenu: [
      { label: "Command palette", accelerator: "CmdOrCtrl+K", click: a.palette },
      { type: "separator" },
      { id: "zoom-reset", label: "Actual Size", accelerator: "CmdOrCtrl+0", click: a.zoomReset },
      { id: "zoom-in", label: "Zoom In", accelerator: "CmdOrCtrl+Plus", click: a.zoomIn },
      { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: a.zoomIn, visible: false },
      { id: "zoom-out", label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: a.zoomOut },
      { type: "separator" },
      fullScreen,
      ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as MenuItemConstructorOptions]),
    ],
  };
}

export function appMenuTemplate(
  a: MenuActions,
  platform: NodeJS.Platform = process.platform,
): MenuItemConstructorOptions[] {
  if (platform === "win32") {
    return [
      {
        label: "File",
        submenu: [
          { label: "New side chat", accelerator: "Ctrl+N", click: a.newSideChat },
          { label: "Settings…", accelerator: "Ctrl+,", click: a.settings },
          { type: "separator" },
          { label: "Close", accelerator: "Ctrl+W", click: a.closeThreadView },
          { type: "separator" },
          {
            label: "Quit Psyche (tasks keep running)",
            accelerator: "Ctrl+Q",
            click: () => app.quit(),
          },
          { label: "Quit Psyche entirely", accelerator: "Ctrl+Shift+Q", click: a.quitEntirely },
        ],
      },
      { role: "editMenu" },
      viewMenu(a, { role: "togglefullscreen", accelerator: "F11" }),
      { role: "windowMenu" },
    ];
  }
  return [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: a.settings },
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
    viewMenu(a, { role: "togglefullscreen" }),
    { role: "windowMenu" },
  ];
}

export function buildAppMenu(a: MenuActions, platform: NodeJS.Platform = process.platform): Menu {
  return Menu.buildFromTemplate(appMenuTemplate(a, platform));
}

/**
 * Windows: the menu's accelerators stay, its bar never shows (nor on Alt): the window draws its
 * own title bar.
 */
export function hideMenuBar(win: {
  setMenuBarVisibility?(visible: boolean): void;
  setAutoHideMenuBar?(hide: boolean): void;
}): void {
  win.setAutoHideMenuBar?.(false);
  win.setMenuBarVisibility?.(false);
}
