import { randomUUID } from "node:crypto";
import { PsycheError, type ViewLayout, type ViewOpenParams } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { isLocalDesktopCall } from "./files.ts";

/**
 * `view.*`: pane control for the desktop shell (protocol methods/view.ts). A client asks for a pane
 * change; the Gateway publishes it as a `view.command` event and the desktop applies it. Only the
 * desktop renders panes, so with no desktop connected the calls answer `unavailable`.
 *
 * Security: `view.open`, `view.close` and `view.focus` are `operator.write`, so a paired phone (or
 * a loopback CLI that is not the desktop shell) can call them. Those callers may only show or
 * focus display-only panes:
 * - `terminal` is desktop-only in both directions: opening it starts a host shell (its target is
 *   the shell's cwd), and closing it kills the owner's running shell;
 * - `browser`, `files`, `editor`, `diff` with a `target` are desktop-only: a target would navigate
 *   the browser or read a path, and that must stay the desktop's decision with its own approvals.
 * A `view.close` by `paneId` from a non-desktop caller is allowed only for a pane the last
 * reported layout shows as a non-terminal pane; anything else (unknown, or no report) is refused.
 */

/** Panes a non-desktop caller may never open: each one starts a shell on the Host. */
const REFUSED_FROM_REMOTE = new Set(["terminal"]);
/** Panes that take a target a non-desktop caller may not choose (navigation or file access). */
const TARGET_REFUSED_FROM_REMOTE = new Set(["browser", "files", "editor", "diff"]);

/** Why a non-desktop caller may not open this pane, or null when it may. */
export function refusedOpenFromRemote(params: ViewOpenParams): string | null {
  if (REFUSED_FROM_REMOTE.has(params.pane)) {
    return `view.open ${params.pane} is only available on the desktop shell`;
  }
  if (params.target !== undefined && TARGET_REFUSED_FROM_REMOTE.has(params.pane)) {
    return `view.open ${params.pane} with a target is only available on the desktop shell`;
  }
  return null;
}

/**
 * Why a non-desktop caller may not close this pane, or null when it may. `layout` is the last
 * layout the desktop reported (null when there is none): a close by `paneId` needs it to tell
 * whether that pane is a terminal, so an unknown pane is refused.
 */
export function refusedCloseFromRemote(
  params: { pane?: string; paneId?: string },
  layout: ViewLayout | null,
): string | null {
  if (params.pane === "terminal") {
    return "view.close terminal is only available on the desktop shell";
  }
  if (params.paneId !== undefined) {
    const known = layout?.panes.find((p) => p.paneId === params.paneId);
    if (known === undefined) {
      return "view.close by paneId needs a pane the desktop reported; this one is unknown";
    }
    if (known.pane === "terminal") {
      return "view.close terminal is only available on the desktop shell";
    }
  }
  return null;
}

/** A desktop shell is connected on this Mac (live, paired, loopback). */
function desktopConnected(call: Call): boolean {
  for (const conn of call.ctx.connections()) {
    if (conn.open && conn.identity?.desktopShell === true && conn.peer.remoteLoopback === true) {
      return true;
    }
  }
  return false;
}

/** The `view.*` handler map. The last layout the desktop reported lives in this closure. */
export function viewHandlers(): Record<string, HandlerDef> {
  let lastLayout: ViewLayout | null = null;

  /**
   * Answers whether a desktop is connected. With none, the last report is cleared: a layout from
   * a gone desktop is not the current one, and a later close must not trust it.
   */
  const requireDesktop = (call: Call): void => {
    if (desktopConnected(call)) return;
    lastLayout = null;
    throw new PsycheError(
      "unavailable",
      "No desktop shell is connected, so panes cannot be changed right now",
    );
  };

  /** Publishes a command for the desktop shell; returns its fresh id. */
  const publish = (call: Call, command: "open" | "close" | "focus", args: object): string => {
    requireDesktop(call);
    const commandId = randomUUID();
    call.emit("view.command", { commandId, command, args: { ...args } });
    return commandId;
  };

  return {
    "view.open": {
      run(call, p: never) {
        const params = p as ViewOpenParams;
        if (!isLocalDesktopCall(call)) {
          const refused = refusedOpenFromRemote(params);
          if (refused !== null) throw new PsycheError("forbidden", refused);
        }
        return { commandId: publish(call, "open", params) };
      },
    },
    "view.close": {
      run(call, p: never) {
        const params = p as { pane?: string; paneId?: string };
        requireDesktop(call);
        if (!isLocalDesktopCall(call)) {
          const refused = refusedCloseFromRemote(params, lastLayout);
          if (refused !== null) throw new PsycheError("forbidden", refused);
        }
        publish(call, "close", params);
        return { ok: true };
      },
    },
    "view.focus": {
      run(call, p: never) {
        publish(call, "focus", p as object);
        return { ok: true };
      },
    },
    "view.report": {
      run(call, p: never) {
        if (!isLocalDesktopCall(call)) {
          throw new PsycheError("forbidden", "Only the desktop shell reports its pane layout");
        }
        lastLayout = (p as { layout: ViewLayout }).layout;
        return { ok: true };
      },
    },
    "view.layout": {
      run(call) {
        // Null when no desktop is connected: a layout from a gone desktop is not the current one.
        if (!desktopConnected(call)) {
          lastLayout = null;
          return { layout: null };
        }
        return { layout: lastLayout };
      },
    },
  };
}
