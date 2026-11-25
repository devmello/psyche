import type { LoopVisibility } from "@psyche/memory";
import { scrubLoopForRemote } from "@psyche/memory";
import type { DeviceToast } from "@psyche/notifications";
import {
  type GraphLoop,
  type MethodParams,
  type MethodResult,
  type PromiseSummary,
  type PromiseView,
  PsycheError,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "./context.ts";
import { SKIP_EVENT } from "./event-bus.ts";
import type { Reader } from "./message-scrub.ts";

/**
 * The promise scrub (docs/design/promise-ledger-2026.md section 7.2; docs/05-security-and-permissions.md
 * "Promise scrub"). Who may see what, in one place:
 *
 * - The **full view** is the desktop shell on this Mac: a client connection with `desktopShell`
 *   (set only by the loopback handshake with the per-launch secret) on a loopback peer. Nothing in
 *   the request params can grant it: a `desktopShell` param is ignored.
 * - **Every other caller** (iOS, a remote desktop, the web shell, the CLI over the network, a part
 *   of the Gateway with no paired device) is remote. It never sees a promise with a Messages
 *   citation, and never the quote, the person's id, the project, the citations or the history of
 *   any promise. It sees the name as written in the source and a mail link.
 * - A promise is visible to a remote caller only when its row says `remote_visible = 1`
 *   ({@link LoopVisibility}). A null, a 0, a missing row and a read error all hide it.
 * - A hidden promise is `not_found` for `get`, `act` and `memory.loops.update`: the same answer as
 *   an id that does not exist, so the id is no oracle.
 */

/** Who is reading: `full` is the desktop shell on this Mac. */
export interface PromiseViewer {
  full: boolean;
}

/** The desktop shell on a loopback peer. The params of the call are never read. */
export function viewerOfCall(call: Call): PromiseViewer {
  return {
    full:
      call.identity.role === "client" &&
      call.identity.desktopShell === true &&
      call.conn?.peer?.remoteLoopback === true,
  };
}

/** The subscriber behind an event. A part of the Gateway (no paired device) is never full. */
export function viewerOfReader(reader: Reader): PromiseViewer {
  return { full: reader.role === "client" && reader.desktop };
}

/** `forbidden` with `details.reason = "owner_only"`: the answer to a remote caller of an owner-only write. */
export function ownerOnly(what: string): PsycheError {
  return new PsycheError("forbidden", `${what} can only be done from Psyche on your Mac.`, {
    details: { reason: "owner_only" },
  });
}

/** Throws {@link ownerOnly} unless the call is the desktop shell. */
export function requireDesktopShell(call: Call, what: string): void {
  if (!viewerOfCall(call).full) throw ownerOnly(what);
}

/** The setting keys only the desktop shell may write (`promises.sources.mail` …). */
export const isPromiseSourceKey = (key: string): boolean =>
  key === "promises.sources" || key.startsWith("promises.sources.");

/** A mail deep link a remote viewer may be given: an external scheme, never an in-app route. */
const SAFE_LINK = /^(?:message:|mailto:|https?:)/i;

/**
 * The promise with everything a remote viewer may not have removed. It does not decide whether the
 * viewer may see the promise at all: {@link scrubPromise} does.
 */
export function stripPromise(p: PromiseView): PromiseView {
  const { citations: _c, events: _e, link, counterpartId: _p, projectId: _j, ...rest } = p;
  return {
    ...rest,
    counterpartId: null,
    projectId: null,
    ...(p.sourceKind === "mail" && typeof link === "string" && SAFE_LINK.test(link)
      ? { link }
      : {}),
  };
}

/** The promise as `viewer` may see it, or `null` when it is hidden from them. */
export function scrubPromise(
  p: PromiseView,
  viewer: PromiseViewer,
  visible: ReadonlySet<string>,
): PromiseView | null {
  if (viewer.full) return p;
  if (p.sourceKind === "messages" || !visible.has(p.id)) return null;
  return stripPromise(p);
}

/** The ids of `promises` a remote viewer may see. */
function visibleIds(vis: LoopVisibility, promises: readonly { id: string }[]): Set<string> {
  return vis.remoteVisible(promises.map((p) => p.id));
}

/** Which side of the scrub the service should compute counts and pages for. */
export type PromiseAudience = "full" | "remote";

/**
 * What the ledger service (the Gateway service, wave W4) provides. For `audience: "remote"` it must
 * query only `remote_visible = 1` rows and count the rest in `hiddenCount`, so pages and counts
 * are right; the handlers here do not trust that, and filter and strip again.
 */
export interface PromiseService {
  list(
    params: MethodParams<"promises.list">,
    audience: PromiseAudience,
  ): MethodResult<"promises.list"> | Promise<MethodResult<"promises.list">>;
  get(id: string, audience: PromiseAudience): PromiseView | Promise<PromiseView>;
  summary(audience: PromiseAudience): PromiseSummary | Promise<PromiseSummary>;
  act(params: MethodParams<"promises.act">): PromiseView | Promise<PromiseView>;
  add(params: MethodParams<"promises.add">): PromiseView | Promise<PromiseView>;
  delete(params: MethodParams<"promises.delete">): { ok: boolean } | Promise<{ ok: boolean }>;
  mute(params: MethodParams<"promises.mute">): { ok: boolean } | Promise<{ ok: boolean }>;
}

const notFound = (): never => {
  throw new PsycheError("not_found", "no such promise");
};

/**
 * The `promises.*` handlers around a service: the scrub for `list`, `get`, `summary`, `act` and
 * `add`, and the desktop-shell refusal for `delete` and `mute`. W4 mounts these, not the service.
 */
export function promiseHandlers(
  service: PromiseService,
  vis: LoopVisibility,
): Record<string, HandlerDef> {
  const audience = (call: Call): PromiseAudience => (viewerOfCall(call).full ? "full" : "remote");
  return {
    "promises.list": {
      run: async (call: Call, params: MethodParams<"promises.list">) => {
        const viewer = viewerOfCall(call);
        const out = await service.list(params, audience(call));
        if (viewer.full) return out;
        const ok = visibleIds(vis, out.promises);
        const shown = out.promises.flatMap((p) => {
          const s = scrubPromise(p, viewer, ok);
          return s === null ? [] : [s];
        });
        return {
          ...out,
          promises: shown,
          hiddenCount: out.hiddenCount + (out.promises.length - shown.length),
        };
      },
    },
    "promises.get": {
      run: async (call: Call, params: MethodParams<"promises.get">) => {
        const viewer = viewerOfCall(call);
        if (!viewer.full && !vis.remoteVisible([params.id]).has(params.id)) return notFound();
        const p = await service.get(params.id, audience(call));
        const s = scrubPromise(p, viewer, vis.remoteVisible([p.id]));
        return s === null ? notFound() : { promise: s };
      },
    },
    "promises.summary": {
      run: async (call: Call) => {
        const viewer = viewerOfCall(call);
        const summary = await service.summary(audience(call));
        if (viewer.full) return { summary };
        const ok = visibleIds(vis, summary.upcoming);
        const upcoming = summary.upcoming.filter((u) => ok.has(u.id));
        return {
          summary: {
            ...summary,
            upcoming,
            hiddenCount: summary.hiddenCount + (summary.upcoming.length - upcoming.length),
          },
        };
      },
    },
    "promises.act": {
      run: async (call: Call, params: MethodParams<"promises.act">) => {
        const viewer = viewerOfCall(call);
        // A hidden promise is not acted on: checked before the service sees the call.
        if (!viewer.full && !vis.remoteVisible([params.id]).has(params.id)) return notFound();
        const p = await service.act(params);
        const s = scrubPromise(p, viewer, vis.remoteVisible([p.id]));
        return s === null ? notFound() : { promise: s };
      },
    },
    "promises.add": {
      run: async (call: Call, params: MethodParams<"promises.add">) => {
        const p = await service.add(params);
        // The caller wrote it: it is theirs to see back, minus the Memory links.
        return { promise: viewerOfCall(call).full ? p : stripPromise(p) };
      },
    },
    "promises.delete": {
      run: async (call: Call, params: MethodParams<"promises.delete">) => {
        requireDesktopShell(call, "Deleting a promise");
        return service.delete(params);
      },
    },
    "promises.mute": {
      run: async (call: Call, params: MethodParams<"promises.mute">) => {
        requireDesktopShell(call, "Muting a person or a thread");
        return service.mute(params);
      },
    },
  };
}

/**
 * The `promise.updated` payload for one subscriber: the shared payload for the desktop shell, the
 * stripped promise for a remote subscriber who may see it, and {@link SKIP_EVENT} otherwise.
 */
export function personalizePromiseEvent(
  payload: { promise: PromiseView },
  reader: Reader,
  vis: LoopVisibility | undefined,
): { promise: PromiseView } | typeof SKIP_EVENT {
  const viewer = viewerOfReader(reader);
  if (viewer.full) return payload;
  if (vis === undefined) return SKIP_EVENT;
  const s = scrubPromise(payload.promise, viewer, vis.remoteVisible([payload.promise.id]));
  return s === null ? SKIP_EVENT : { ...payload, promise: s };
}

/** The `memory.loop.updated` payload for one subscriber (see {@link personalizePromiseEvent}). */
export function personalizeLoopEvent(
  payload: { loop: GraphLoop },
  reader: Reader,
  vis: LoopVisibility | undefined,
): { loop: GraphLoop } | typeof SKIP_EVENT {
  if (viewerOfReader(reader).full) return payload;
  if (vis === undefined || !vis.remoteVisible([payload.loop.id]).has(payload.loop.id))
    return SKIP_EVENT;
  return { ...payload, loop: scrubLoopForRemote(payload.loop) };
}

/** `/promises/<id>`: the route a `promise_due` notification carries (the id is all we read). */
const PROMISE_ROUTE = /^\/promises\/([A-Za-z0-9_-]{1,64})(?:[/?#].*)?$/;

/**
 * A `notification.device` toast as a remote device may receive it, or `null` for none. Only
 * `promise_due` is rewritten. It names a promise by its route; a toast with no readable route, or
 * for a promise that is hidden from remote callers, is never sent. A toast that goes out says
 * nothing about the promise: no name, no text, no quote, only a localised "a promise is due soon".
 */
export function scrubDeviceToast(
  toast: DeviceToast,
  vis: LoopVisibility | undefined,
): DeviceToast | null {
  if (toast.kind !== "promise_due") return toast;
  const id = toast.route === null ? undefined : PROMISE_ROUTE.exec(toast.route)?.[1];
  if (id === undefined || vis === undefined || !vis.remoteVisible([id]).has(id)) return null;
  return {
    id: toast.id,
    kind: toast.kind,
    title: "A promise is due soon",
    body: "Open Psyche to see which one.",
    message: { titleKey: "notice.promise.due.title", bodyKey: "notice.promise.due.body" },
    route: `/promises/${id}`,
    interruption: toast.interruption,
    createdAt: toast.createdAt,
  };
}
