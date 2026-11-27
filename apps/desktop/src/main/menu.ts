import { createI18n, type MessageId } from "@psyche/ui/i18n-core";
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
 *
 * Labels come from the message catalogue in the system's language (`app.getLocale()`), as the
 * tray's do. Edit, Window and the About/Hide items use Electron's roles, which macOS localizes.
 */
export interface MenuActions {
  newSideChat(): void;
  palette(): void;
  /** View → Toggle Sidebar (⌘B): the sidebar, or the threads drawer when compact. */
  toggleSidebar(): void;
  /** View → Compact Sidebar (⌘⌥B): full sidebar or rail. */
  toggleCompactSidebar(): void;
  closeThreadView(): void;
  quitEntirely(): void;
  /** Opens the Settings window (⌘,; docs/design/redesign-2026.md §4). */
  settings(): void;
  /** View → Zoom: an appearance setting (`appearance.zoom`), not Electron's per-origin memory. */
  zoomIn(): void;
  zoomOut(): void;
  zoomReset(): void;
}

/** The menu's words in one language; English when the locale has no catalogue. */
function menuLabel(locale: string): (id: MessageId) => string {
  const i18n = createI18n({ locale });
  return (id) => i18n.t(id);
}

function viewMenu(
  a: MenuActions,
  label: (id: MessageId) => string,
  fullScreen: MenuItemConstructorOptions,
): MenuItemConstructorOptions {
  return {
    label: label("desktop.menu.view"),
    submenu: [
      {
        label: label("desktop.menu.toggleSidebar"),
        accelerator: "CmdOrCtrl+B",
        click: a.toggleSidebar,
      },
      {
        label: label("desktop.menu.compactSidebar"),
        accelerator: "CmdOrCtrl+Alt+B",
        click: a.toggleCompactSidebar,
      },
      { type: "separator" },
      {
        label: label("shell.shortcut.palette"),
        accelerator: "CmdOrCtrl+K",
        click: a.palette,
      },
      { type: "separator" },
      {
        id: "zoom-reset",
        label: label("desktop.menu.actualSize"),
        accelerator: "CmdOrCtrl+0",
        click: a.zoomReset,
      },
      {
        id: "zoom-in",
        label: label("desktop.menu.zoomIn"),
        accelerator: "CmdOrCtrl+Plus",
        click: a.zoomIn,
      },
      {
        label: label("desktop.menu.zoomIn"),
        accelerator: "CmdOrCtrl+=",
        click: a.zoomIn,
        visible: false,
      },
      {
        id: "zoom-out",
        label: label("desktop.menu.zoomOut"),
        accelerator: "CmdOrCtrl+-",
        click: a.zoomOut,
      },
      { type: "separator" },
      fullScreen,
      ...(app.isPackaged ? [] : [{ role: "toggleDevTools" } as MenuItemConstructorOptions]),
    ],
  };
}

export function appMenuTemplate(
  a: MenuActions,
  platform: NodeJS.Platform = process.platform,
  locale = "en",
): MenuItemConstructorOptions[] {
  const label = menuLabel(locale);
  if (platform === "win32") {
    return [
      {
        label: label("desktop.menu.file"),
        submenu: [
          { label: label("desktop.menu.newChat"), accelerator: "Ctrl+N", click: a.newSideChat },
          { label: label("desktop.menu.settings"), accelerator: "Ctrl+,", click: a.settings },
          { type: "separator" },
          { label: label("common.close"), accelerator: "Ctrl+W", click: a.closeThreadView },
          { type: "separator" },
          {
            label: label("desktop.menu.quitTasks"),
            accelerator: "Ctrl+Q",
            click: () => app.quit(),
          },
          {
            label: label("desktop.menu.quitEntirely"),
            accelerator: "Ctrl+Shift+Q",
            click: a.quitEntirely,
          },
        ],
      },
      { role: "editMenu" },
      viewMenu(a, label, { role: "togglefullscreen", accelerator: "F11" }),
      { role: "windowMenu" },
    ];
  }
  return [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        {
          label: label("desktop.menu.settings"),
          accelerator: "CmdOrCtrl+,",
          click: a.settings,
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { type: "separator" },
        {
          label: label("desktop.menu.quitTasks"),
          accelerator: "CmdOrCtrl+Q",
          click: () => app.quit(),
        },
        {
          label: label("desktop.menu.quitEntirely"),
          accelerator: "CmdOrCtrl+Alt+Q",
          click: a.quitEntirely,
        },
      ],
    },
    {
      label: label("desktop.menu.file"),
      submenu: [
        {
          label: label("desktop.menu.newChat"),
          accelerator: "CmdOrCtrl+N",
          click: a.newSideChat,
        },
        { label: label("common.close"), accelerator: "CmdOrCtrl+W", click: a.closeThreadView },
      ],
    },
    { role: "editMenu" },
    viewMenu(a, label, { role: "togglefullscreen" }),
    { role: "windowMenu" },
  ];
}

export function buildAppMenu(
  a: MenuActions,
  platform: NodeJS.Platform = process.platform,
  locale = "en",
): Menu {
  return Menu.buildFromTemplate(appMenuTemplate(a, platform, locale));
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
