import { randomUUID } from "node:crypto";
import { PsycheError, type ViewLayout, type ViewOpenParams } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import { isLocalDesktopCall } from "./files.ts";

/**
 * `view.*`: pane control for the desktop shell (protocol methods/view.ts). A client asks for a pane
 * change; the Gateway publishes it as a `view.command` event and the desktop applies it. Only the
 * desktop renders panes, so with no desktop connected the calls answer `unavailable`.
 *
 * Security: `view.open` is `operator.write`, so a paired phone can call it. A phone may only show
 * a pane. Pane/target shapes refused from any caller that is not the desktop shell:
 * - `terminal`: the desktop starts a host shell (its target is the shell's cwd);
 * - `browser`, `files`, `editor`, `diff` with a `target`: a target would navigate the browser or
 *   read a path, and that must stay the desktop's decision with its own approvals.
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

  /** Publishes a command for the desktop shell; returns its fresh id. */
  const publish = (call: Call, command: "open" | "close" | "focus", args: object): string => {
    if (!desktopConnected(call)) {
      throw new PsycheError(
        "unavailable",
        "No desktop shell is connected, so panes cannot be changed right now",
      );
    }
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
        publish(call, "close", p as object);
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
        return { layout: desktopConnected(call) ? lastLayout : null };
      },
    },
  };
}
