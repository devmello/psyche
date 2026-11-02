import { getSetting, getWidgets } from "@psyche/db";
import { type MethodParams, type MethodResult, PsycheError } from "@psyche/protocol";
import type { Call } from "../context.ts";
import { requireThread } from "../handlers/threads.ts";
import { resolveToolAction } from "../widgets/act.ts";
import { checkWidgetBindings } from "../widgets/bindings.ts";
import { fetchWidgetImage } from "../widgets/image.ts";
import { claimWidgetClick } from "../widgets/rate.ts";
import { WidgetStore } from "../widgets/store.ts";
import { widgetTools } from "../widgets/tools.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

export const REMOTE_IMAGES_KEY = "widgets.remoteImages";

/** Every remote image URL a spec's nodes name. */
export function specImageUrls(root: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown, depth: number): void => {
    if (!n || typeof n !== "object" || Array.isArray(n) || depth > 12) return;
    const node = n as Record<string, unknown>;
    const src = node.src as { url?: unknown } | undefined;
    if (node.type === "image" && typeof src?.url === "string") out.push(src.url);
    if (Array.isArray(node.children)) for (const c of node.children) walk(c, depth + 1);
    if (Array.isArray(node.tabs)) {
      for (const t of node.tabs) {
        const kids = (t as { children?: unknown[] }).children;
        if (Array.isArray(kids)) for (const c of kids) walk(c, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Generative-UI widgets (docs/design/generative-ui-2026.md). Snapshots by id, and the agent's `render_ui`, `update_ui` and
 * `list_ui` tools (deferred by default: not in `ALWAYS_ON`).
 */
export function composeWidgets(services: ComposeServices): ComposedPart {
  const store = new WidgetStore({
    db: services.db,
    bindings: (root, threadId) => checkWidgetBindings(services.db, root, threadId),
    publish: (event, payload, threadId) => services.publish(event, payload, threadId),
  });
  const unregister = widgetTools(store).map((t) => services.tools.register(t));
  let unsubscribe: (() => void) | undefined;
  const ENDED = new Set(["done", "failed", "cancelled"]);
  return {
    // A task that ends freezes the widgets it owns (generative-ui-2026 §5.1); bound ones keep going.
    start: (gw) => {
      unsubscribe = gw.bus.subscribe(["operator.read"], (frame) => {
        let f: { event?: string; payload?: { task?: { id?: string; status?: string } } };
        try {
          f = JSON.parse(frame);
        } catch {
          return;
        }
        const task = f.payload?.task;
        if (f.event === "task.updated" && task?.id && task.status && ENDED.has(task.status)) {
          store.freezeOwnedBy("task", task.id);
        }
      });
    },
    stop: () => {
      unsubscribe?.();
      unsubscribe = undefined;
      store.flush();
      for (const u of unregister) u();
    },
    handlers: {
      "widgets.act": {
        transactional: true,
        run: (call: Call, p: MethodParams<"widgets.act">): MethodResult<"widgets.act"> => {
          const [widget] = getWidgets(services.db, [p.widgetId]);
          if (widget === undefined) throw new PsycheError("not_found", "No such widget.");
          const thread = requireThread(call, widget.threadId);
          const action = resolveToolAction(widget.spec, p.nodeId, p.itemId, p.values);
          claimWidgetClick(widget.id);
          // The owner reads exactly what is proposed; the widget's taint rides along as requester
          // taint, and the text is the widget's, so it names no targets (§7.3).
          const result = call.ctx.sessions.send(
            {
              threadId: thread.id,
              content: action.text,
              deviceId: call.identity.deviceId,
              via: "widget",
              ownerWords: false,
              proposedCall: { tool: action.tool, input: action.args },
              ...(widget.taint.length === 0 ? {} : { taintSources: widget.taint }),
            },
            { emit: call.emit, afterCommit: call.afterCommit },
          );
          return { messageId: result.messageId, runId: result.runId ?? null };
        },
      },
      "widgets.preview": {
        run: async (
          call: Call,
          p: MethodParams<"widgets.preview">,
        ): Promise<MethodResult<"widgets.preview">> => {
          const [widget] = getWidgets(services.db, [p.widgetId]);
          if (widget === undefined) throw new PsycheError("not_found", "No such widget.");
          const thread = requireThread(call, widget.threadId);
          const action = resolveToolAction(widget.spec, p.nodeId, p.itemId, undefined, {
            preview: true,
          });
          const verdict = await call.ctx.agent.previewCall?.({
            threadId: thread.id,
            tool: action.tool,
            input: action.args,
            permissionMode: thread.permissionMode,
            taintSources: widget.taint,
          });
          return { tool: action.tool, decision: verdict?.decision ?? "unavailable" };
        },
      },
      "widgets.image": {
        run: async (
          _c: Call,
          p: MethodParams<"widgets.image">,
        ): Promise<MethodResult<"widgets.image">> => {
          // D3: off unless the owner turned it on; and only a URL the widget's own spec names.
          if (getSetting(services.db, REMOTE_IMAGES_KEY)?.value !== true) {
            throw new PsycheError(
              "policy_denied",
              "Remote images in widgets are off (Settings: widgets.remoteImages).",
            );
          }
          const [widget] = getWidgets(services.db, [p.widgetId]);
          if (widget === undefined || !specImageUrls(widget.spec.root).includes(p.url)) {
            throw new PsycheError("not_found", "That image is not part of this widget.");
          }
          const img = await fetchWidgetImage(p.url);
          return { mime: img.mime, bytes: Buffer.from(img.bytes).toString("base64") };
        },
      },
      "widgets.get": {
        run: (_c: Call, p: MethodParams<"widgets.get">): MethodResult<"widgets.get"> => {
          const widgets = getWidgets(services.db, p.widgetIds);
          const found = new Set(widgets.map((w) => w.id));
          return { widgets, missing: p.widgetIds.filter((id) => !found.has(id)) };
        },
      },
    },
  };
}
