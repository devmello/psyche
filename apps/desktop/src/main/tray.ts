import { createI18n, type MessageId } from "@psyche/ui/i18n-core";
import {
  app,
  Menu,
  type MenuItemConstructorOptions,
  type NativeImage,
  nativeImage,
  Tray,
} from "electron";
import type { GatewayStatus } from "../client/index.ts";
import { hostPlatform, isLinux, type Platform, traitsFor } from "../platform/index.ts";
import type { GatewayRunState } from "./supervisor-base.ts";
import { TRAY_ICON_SIZES, toBgraPremultiplied, trayIconRgba } from "./tray-icon.ts";

/**
 * Menu-bar item on macOS, notification-area icon on Windows, StatusNotifierItem on Linux (docs/06 §3.22, feature A7): status,
 * usage meter placeholder, what needs you, shortcuts into the app, and the Gateway row that
 * exists because the window can close while work continues. "Quit Psyche" leaves the Gateway
 * running; "Quit Psyche entirely" stops it.
 *
 * On Windows a left click opens Psyche and a right click shows the same menu; the icon is the
 * monochrome mark in the taskbar's light or dark (`tray-icon.ts`), with a dot while something
 * needs you, and the tooltip says what. Linux draws the same mark (no title text, no click
 * handler: the menu is the interface) and main.ts creates no tray at all when no
 * StatusNotifierWatcher is on the session bus (`platform/tray-support.ts`).
 */

export interface TrayModel {
  status: GatewayStatus;
  run: GatewayRunState;
  pendingApprovals: number;
  /** Percent remaining from the usage ledger; null until the Gateway reports it. */
  usagePercentRemaining: number | null;
  /** The accelerators registered now, shown beside their items ("" or unset: none). */
  shortcuts?: { quickEntry?: string; askScreen?: string };
  /** `points.enabled`: the Psyche points row shows only while it is on (off until the owner's pass). */
  pointsEnabled?: boolean;
  /** The labels' language (`app.getLocale()` by default; English when absent). */
  locale?: string;
}

export interface TrayActions {
  open(): void;
  newSideChat(): void;
  quickEntry(): void;
  /** Ask about my screen (docs/design/screen-ask-2026.md §2). */
  /** Absent where Ask about screen is off (a client of another computer's Gateway). */
  askScreen?(): void;
  /**
   * Point me through this window… (docs/design/psyche-points-2026.md §6.2): hides Psyche, targets
   * the window behind and opens the start sheet. Absent off a Mac and for a client of another
   * computer's Gateway.
   */
  pointsStart?(): void;
  openApprovals(): void;
  closeWindow(): void;
  quitApp(): void;
  quitEntirely(): void;
}

/** The Psyche points row in English (the tray shows `desktop.tray.pointsRow` in the language). */
export const POINTS_TRAY_LABEL = "Point me through this window…";

/** The tray's words in one language; English when there is no catalogue for it. */
function trayWords(locale: string | undefined) {
  const i18n = createI18n({ locale: locale ?? "en" });
  return (id: MessageId, values?: Record<string, string | number>) => i18n.t(id, values);
}

/** The system's language, for the tray's labels (English when Electron cannot say). */
export function systemLocale(): string {
  try {
    return app.getLocale();
  } catch {
    return "en";
  }
}

/** The tray's status row, in Psyche's name (#539); dev and external runs say so for developers. */
export function gatewayRowLabel(run: GatewayRunState, locale?: string): string {
  const t = trayWords(locale);
  if (run.kind === "running")
    return run.mode === "launchd" || run.mode === "taskscheduler" || run.mode === "systemd"
      ? t("desktop.tray.gatewayRunning")
      : t(
          run.mode === "dev"
            ? "desktop.tray.gatewayRunningDev"
            : "desktop.tray.gatewayRunningExternal",
        );
  if (run.kind === "starting") return t("desktop.tray.gatewayStarting");
  if (run.kind === "stopped")
    return run.reason
      ? t("desktop.tray.gatewayStoppedReason", { reason: run.reason })
      : t("desktop.tray.gatewayStopped");
  return t("desktop.tray.gatewayChecking");
}

/** What the menu shows before the registered shortcuts are known. */
function defaultShortcutLabels(platform: Platform = hostPlatform()): {
  quickEntry: string;
  askScreen: string;
} {
  return {
    quickEntry: isLinux(platform) ? traitsFor(platform).quickEntryLabel : "Alt+Space",
    askScreen: "Alt+Shift+Space",
  };
}

/** An accelerator for a menu item, only when one is registered. */
function accel(
  a: string | undefined,
): Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator"> {
  return a ? { accelerator: a, registerAccelerator: false } : {};
}

export function trayTemplate(m: TrayModel, a: TrayActions): MenuItemConstructorOptions[] {
  const connected = m.status.phase === "paired";
  const keys = m.shortcuts ?? defaultShortcutLabels();
  const t = trayWords(m.locale);
  return [
    {
      label: connected
        ? t("desktop.tray.statusConnected")
        : t("desktop.tray.statusOther", { phase: m.status.phase }),
      enabled: false,
    },
    {
      label:
        m.usagePercentRemaining === null
          ? t("desktop.tray.usageUnknown")
          : t("desktop.tray.usageRemaining", { percent: Math.round(m.usagePercentRemaining) }),
      enabled: false,
    },
    m.pendingApprovals > 0
      ? {
          // The count only: the card itself is shown once, in the chat (approvals wave W3).
          label: t("desktop.tray.needsYou", { count: m.pendingApprovals }),
          click: a.openApprovals,
        }
      : { label: t("desktop.tray.nothingNeedsYou"), enabled: false },
    { type: "separator" },
    { label: t("desktop.menu.openPsyche"), click: a.open },
    { label: t("desktop.menu.newChat"), click: a.newSideChat },
    { label: t("desktop.menu.quickEntry"), ...accel(keys.quickEntry), click: a.quickEntry },
    ...(a.askScreen
      ? [{ label: t("settings.screenAsk.title"), ...accel(keys.askScreen), click: a.askScreen }]
      : []),
    ...(a.pointsStart && m.pointsEnabled === true
      ? [{ label: t("desktop.tray.pointsRow"), click: a.pointsStart }]
      : []),
    { type: "separator" },
    { label: gatewayRowLabel(m.run, m.locale), enabled: false },
    { type: "separator" },
    { label: t("desktop.menu.closeWindow"), click: a.closeWindow },
    { label: t("desktop.menu.quitTasks"), click: a.quitApp },
    { label: t("desktop.menu.quitEntirely"), click: a.quitEntirely },
  ];
}

/** The tooltip (Windows shows it on hover; at most 127 characters). */
export function trayTooltip(m: TrayModel): string {
  const t = trayWords(m.locale);
  const state =
    m.status.phase === "paired"
      ? m.pendingApprovals > 0
        ? m.pendingApprovals === 1
          ? t("desktop.tray.tooltipNeedOne")
          : t("desktop.tray.tooltipNeedMany", { count: m.pendingApprovals })
        : t("desktop.tray.tooltipConnected")
      : m.status.phase;
  return t("desktop.tray.statusOther", { phase: state }).slice(0, 127);
}

export interface PsycheTrayOptions {
  platform?: Platform;
  /** Windows, Linux: whether the taskbar or panel is dark (its glyph is white then). */
  taskbarDark?: () => boolean;
}

/** The mark at every tray scale, for `new Tray` / `setImage`. */
export function trayImage(o: { dark: boolean; badge: boolean }): NativeImage {
  const image = nativeImage.createEmpty();
  for (const size of TRAY_ICON_SIZES) {
    const { width, height, rgba } = trayIconRgba(size, o);
    image.addRepresentation({
      scaleFactor: size / 16,
      width,
      height,
      buffer: toBgraPremultiplied(rgba),
    });
  }
  return image;
}

export class PsycheTray {
  private readonly tray: Tray;
  private readonly actions: TrayActions;
  private readonly opts: PsycheTrayOptions;
  private model: TrayModel;
  private iconKey = "";

  constructor(model: TrayModel, actions: TrayActions, opts: PsycheTrayOptions = {}) {
    this.actions = actions;
    this.model = { locale: systemLocale(), ...model };
    this.opts = opts;
    this.tray = new Tray(this.icon ? this.image() : nativeImage.createEmpty());
    this.tray.setToolTip("Psyche");
    if (this.windows) {
      // Windows: left click opens Psyche; the menu is the right click (setContextMenu).
      this.tray.on("click", () => this.actions.open());
      this.tray.on("double-click", () => this.actions.open());
    }
    this.render();
  }

  private get windows(): boolean {
    return (this.opts.platform ?? hostPlatform()) === "win32";
  }

  /** The tray shows the mark itself (Windows, Linux) rather than a title beside a template icon. */
  private get icon(): boolean {
    return !traitsFor(this.opts.platform ?? hostPlatform()).trayTitle;
  }

  private image(): NativeImage {
    const dark = this.opts.taskbarDark?.() ?? true;
    const badge = this.model.pendingApprovals > 0;
    this.iconKey = `${dark}:${badge}`;
    return trayImage({ dark, badge });
  }

  update(patch: Partial<TrayModel>): void {
    this.model = { ...this.model, ...patch };
    this.render();
  }

  /** The taskbar switched between light and dark (Windows): redraw the glyph. */
  refreshIcon(): void {
    if (!this.icon) return;
    this.iconKey = "";
    this.render();
  }

  private render(): void {
    const m = this.model;
    if (this.icon) {
      const dark = this.opts.taskbarDark?.() ?? true;
      if (this.iconKey !== `${dark}:${m.pendingApprovals > 0}`) this.tray.setImage(this.image());
      this.tray.setToolTip(trayTooltip(m));
    } else {
      // Title text stands in for the template icon until S12 ships the moth glyph.
      this.tray.setTitle(m.pendingApprovals > 0 ? `ψ ${m.pendingApprovals}` : "ψ");
    }
    this.tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(m, this.actions)));
  }

  /** Windows: a one-off balloon from the icon (the first close to the tray). */
  notify(title: string, content: string): void {
    if (!this.windows) return;
    this.tray.displayBalloon({ title, content, iconType: "info", noSound: true });
  }

  destroy(): void {
    this.tray.destroy();
  }
}
