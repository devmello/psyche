import {
  type DictationKey,
  type DictationKeyPayload,
  type NodeClient,
  type NodeInfo,
  type NodeInvokeResult,
  PsycheError,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import { surfaceOf } from "./handlers.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * System-wide dictation (features J9, Q2): `dictation.target`, `dictation.insert` and
 * `dictation.watch` forwarded to the newest live mac-helper node's capabilities of the same
 * names. The desktop dictates through `voice.*` like the composer (same engine, same custom
 * vocabulary) and then asks for the final text to be inserted into the app that had focus.
 *
 * Inserted text is the owner's keystrokes into another app: it never reaches the agent, a thread
 * or memory, and these methods skip the Permission Broker's agent gates the way typing on the
 * keyboard does. Two rules keep that safe: only a desktop device (platform `macos`) may call
 * them, and `nodes.invoke` / agent tools can never reach `dictation.*` (`isUnreachableCapability`).
 * The helper refuses secure fields and Psyche's windows and never presses Return. The receipt
 * names the app and the length, never the text.
 */

/** How long a watch may stay open before the desktop must re-arm it (setTimeout's ceiling). */
export const DICTATION_WATCH_TIMEOUT_MS = 2_147_000_000;
/** `dictation.watch` waits this long for the helper's first event (the key's initial state). */
export const DICTATION_WATCH_ARM_MS = 2_000;

export const DICTATION_METHODS = [
  "dictation.target",
  "dictation.insert",
  "dictation.watch",
] as const;

/** The newest live mac-helper node that offers `capability`. */
export function dictationNode(
  gateway: () => Gateway | null,
  capability: string,
): NodeClient | undefined {
  const nodes = gateway()?.context.nodes;
  if (!nodes) return undefined;
  const node = nodes
    .list()
    .filter(
      (n: NodeInfo) =>
        n.kind === "mac-helper" &&
        n.capabilities.some((c) => c.name === capability) &&
        nodes.isLive(n.id),
    )
    .at(-1);
  return node === undefined ? undefined : nodes.client(node.id);
}

function unwrap(r: NodeInvokeResult): unknown {
  if (r.ok) return r.result;
  const e = r.error;
  const details = (e?.details ?? {}) as Record<string, unknown>;
  throw new PsycheError((e?.code as never) ?? "internal", e?.message ?? "the Mac helper failed", {
    details,
    ...(e?.retryable === true ? { retryable: true } : {}),
  });
}

interface Watch {
  abort: AbortController;
  key: DictationKey;
}

export function composeDictation() {
  return (services: ComposeServices): ComposedPart => {
    let gateway: Gateway | null = null;
    const { db } = services;
    const watches = new Map<string, Watch>();

    const requireDesktop = (call: Call) => {
      if (surfaceOf(db, call.identity.deviceId) !== "desktop") {
        throw new PsycheError(
          "forbidden",
          "system-wide dictation is only for the Psyche desktop app",
        );
      }
    };
    const requireNode = (capability: string): NodeClient => {
      const node = dictationNode(() => gateway, capability);
      if (!node) {
        throw new PsycheError("unavailable", "the Psyche helper is not running on this Mac", {
          retryable: true,
        });
      }
      return node;
    };

    /**
     * The Gateway sends no node.cancel, so ending a watch for good sends the helper a null watch.
     * Replacing one does not: the helper's newer watch ends the old tap itself, and a null sent
     * alongside could overtake the new watch.
     */
    const stopWatch = (deviceId: string, tellHelper: boolean) => {
      const w = watches.get(deviceId);
      if (!w) return;
      watches.delete(deviceId);
      w.abort.abort();
      if (!tellHelper) return;
      const node = dictationNode(() => gateway, "dictation.watch");
      void node?.invoke("dictation.watch", { key: null }).catch(() => undefined);
    };

    const handlers: Record<string, HandlerDef> = {
      "dictation.target": {
        async run(call: Call) {
          requireDesktop(call);
          return unwrap(await requireNode("dictation.target").invoke("dictation.target", {}));
        },
      },
      "dictation.insert": {
        async run(call: Call, params: { text: string; expectPid?: number }) {
          requireDesktop(call);
          const node = requireNode("dictation.insert");
          const r = await node.invoke("dictation.insert", {
            text: params.text,
            ...(params.expectPid === undefined ? {} : { expectPid: params.expectPid }),
          });
          const result = unwrap(r) as { chars: number; target: { appName: string } };
          const receipt = await call.ctx.broker.recordReceipt({
            kind: "node.dictation.insert",
            outcome: r.receipt?.outcome ?? "ok",
            summary:
              r.receipt?.summary ??
              `Dictated ${result.chars} characters into ${result.target.appName}`,
            approvalId: null,
          });
          if (!call.ctx.brokerPublishesReceipts)
            call.ctx.bus.publish("receipt.created", { receipt });
          return result;
        },
      },
      "dictation.watch": {
        async run(call: Call, params: { key: DictationKey | null }) {
          requireDesktop(call);
          const deviceId = call.identity.deviceId;
          stopWatch(deviceId, params.key === null);
          if (params.key === null) return { watching: false };
          const node = requireNode("dictation.watch");
          const key = params.key;
          const abort = new AbortController();
          watches.set(deviceId, { abort, key });
          let armed: (() => void) | undefined;
          const firstEvent = new Promise<void>((resolve) => {
            armed = resolve;
          });
          const done = node.invoke(
            "dictation.watch",
            { key },
            {
              signal: abort.signal,
              timeoutMs: DICTATION_WATCH_TIMEOUT_MS,
              onEvent: (e) => {
                armed?.();
                const d = e.data as Partial<DictationKeyPayload> | null;
                if (watches.get(deviceId)?.abort !== abort) return;
                if (typeof d?.down !== "boolean") return;
                gateway?.bus.publishToDevice(deviceId, "dictation.key", {
                  key,
                  down: d.down,
                  at: typeof d.at === "string" ? d.at : new Date().toISOString(),
                });
              },
            },
          );
          void done.then(() => {
            if (watches.get(deviceId)?.abort === abort) watches.delete(deviceId);
          });
          // The helper sends the key's state as soon as its tap is installed; a failure
          // (no Accessibility) arrives as the result instead.
          const outcome = await Promise.race([
            firstEvent.then(() => "armed" as const),
            done,
            new Promise<"slow">((r) => setTimeout(() => r("slow"), DICTATION_WATCH_ARM_MS).unref()),
          ]);
          if (outcome === "armed" || outcome === "slow") return { watching: true };
          if (watches.get(deviceId)?.abort === abort) watches.delete(deviceId);
          unwrap(outcome);
          return { watching: false };
        },
      },
    };

    const onDisconnect = (deviceId: string) => stopWatch(deviceId, true);
    return {
      handlers,
      start(gw) {
        gateway = gw;
        gw.context.deviceDisconnected.add(onDisconnect);
      },
      stop() {
        gateway?.context.deviceDisconnected.delete(onDisconnect);
        for (const id of [...watches.keys()]) stopWatch(id, true);
        gateway = null;
      },
    };
  };
}
