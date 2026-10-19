import type { GatewayStatus } from "@psyche/web/client";
import { Menu, type MenuItemConstructorOptions, nativeImage, Tray } from "electron";
import type { GatewayRunState } from "./supervisor.ts";

/**
 * Menu-bar item (docs/06 §3.22, feature A7): status, usage meter placeholder, what needs you,
 * shortcuts into the app, and the Gateway row that exists because the window can close while
 * work continues. "Quit Psyche" leaves the Gateway running; "Quit Psyche entirely" stops it.
 */

export interface TrayModel {
  status: GatewayStatus;
  run: GatewayRunState;
  pendingApprovals: number;
  firstApproval?: string;
  /** Percent remaining from the usage ledger; null until the Gateway reports it. */
  usagePercentRemaining: number | null;
}

export interface TrayActions {
  open(): void;
  newSideChat(): void;
  quickEntry(): void;
  openApprovals(): void;
  closeWindow(): void;
  quitApp(): void;
  quitEntirely(): void;
}

export function gatewayRowLabel(run: GatewayRunState): string {
  if (run.kind === "running")
    return `Gateway: running (${run.mode === "launchd" ? "launchd" : run.mode === "dev" ? "dev child" : "external"})`;
  if (run.kind === "stopped") return `Gateway: stopped${run.reason ? ` (${run.reason})` : ""}`;
  return "Gateway: checking…";
}

export function trayTemplate(m: TrayModel, a: TrayActions): MenuItemConstructorOptions[] {
  const connected = m.status.phase === "paired";
  return [
    { label: connected ? "Psyche — connected" : `Psyche — ${m.status.phase}`, enabled: false },
    {
      label:
        m.usagePercentRemaining === null
          ? "Usage: —"
          : `Usage: ${Math.round(m.usagePercentRemaining)}% remaining`,
      enabled: false,
    },
    m.pendingApprovals > 0
      ? {
          label: `Needs you (${m.pendingApprovals})${m.firstApproval ? `: ${m.firstApproval.slice(0, 40)}` : ""}`,
          click: a.openApprovals,
        }
      : { label: "Nothing needs you", enabled: false },
    { type: "separator" },
    { label: "Open Psyche", click: a.open },
    { label: "New side chat", click: a.newSideChat },
    { label: "Quick entry", accelerator: "Alt+Space", click: a.quickEntry },
    { type: "separator" },
    { label: gatewayRowLabel(m.run), enabled: false },
    { type: "separator" },
    { label: "Close window", click: a.closeWindow },
    { label: "Quit Psyche (tasks keep running)", click: a.quitApp },
    { label: "Quit Psyche entirely", click: a.quitEntirely },
  ];
}

export class PsycheTray {
  private readonly tray: Tray;
  private readonly actions: TrayActions;
  private model: TrayModel;

  constructor(model: TrayModel, actions: TrayActions) {
    this.actions = actions;
    this.model = model;
    this.tray = new Tray(nativeImage.createEmpty());
    this.tray.setToolTip("Psyche");
    this.render();
  }

  update(patch: Partial<TrayModel>): void {
    this.model = { ...this.model, ...patch };
    this.render();
  }

  private render(): void {
    const m = this.model;
    // Title text stands in for the template icon until S12 ships the moth glyph.
    this.tray.setTitle(m.pendingApprovals > 0 ? `ψ ${m.pendingApprovals}` : "ψ");
    this.tray.setContextMenu(Menu.buildFromTemplate(trayTemplate(m, this.actions)));
  }

  destroy(): void {
    this.tray.destroy();
  }
}
