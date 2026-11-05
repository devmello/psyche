import { getSetting } from "@psyche/db";
import { appCap } from "@psyche/permissions";
import {
  classifyTeachValue,
  isTeachAppKind,
  type NodeClient,
  type NodeInvokeResult,
  PsycheError,
  sanitizeTeachSteps,
  type TeachAppCapture,
  type TeachAppCapturedStep,
  type TeachAppChoice,
  type TeachAppStatus,
  teachAppNever,
  teachText,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import { COMPUTER_USE_APPS, COMPUTER_USE_ENABLED } from "./computer-settings.ts";
import { dictationNode } from "./dictation.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * Teach by showing in a Mac app (J8 phase 2, docs/design/teach-by-showing-2026.md §13).
 * `teach.app.*` forwards the owner's click to the Host's own Mac helper (`teach.record.*`), which
 * watches one granted app's accessibility events and returns semantic steps.
 *
 * Who can start it is a property of the wiring, not a rule the agent follows:
 * - only the Psyche desktop shell on the Host may call these methods (`identity.desktopShell`,
 *   the per-launch handshake secret); the desktop's main process calls them on the owner's click;
 * - `nodes.invoke` and agent node tools can never reach the helper's `teach.*` capabilities
 *   (`isUnreachableCapability`), and there is no agent tool that starts, stops or reads a recording;
 * - the helper enforces the grant list again and refuses Psyche and system security prompts.
 *
 * Nothing is stored here: a result passes through to the review screen and is gone. Audit rows and
 * receipts name the app and a step count, never a name, a path or a typed value.
 */

const CALL_TIMEOUT_MS = 20_000;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9_-]+)+$/;
const TIERS = new Set(["read", "click", "interact"]);

function unwrap(r: NodeInvokeResult): unknown {
  if (r.ok) return r.result;
  const e = r.error;
  throw new PsycheError((e?.code as never) ?? "internal", e?.message ?? "the Mac helper failed", {
    details: (e?.details ?? {}) as Record<string, unknown>,
    ...(e?.retryable === true ? { retryable: true } : {}),
  });
}

/** Display name for a bundle id until the helper reports the real one. */
function displayName(bundleId: string): string {
  return bundleId.split(".").at(-1) ?? bundleId;
}

/**
 * The apps the owner can record in: granted in Settings → Computer use (a tier above Off, with the
 * feature on), not capped below `interact` (browsers, terminals, banking, settings) and not on the
 * never-recorded list (Psyche, security prompts, password managers).
 */
export function recordableApps(enabled: unknown, rows: unknown): TeachAppChoice[] {
  if (enabled !== true || !Array.isArray(rows)) return [];
  const out: TeachAppChoice[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const r = row as { id?: unknown; name?: unknown; tier?: unknown } | null;
    if (typeof r?.id !== "string" || !BUNDLE_ID.test(r.id) || r.id.length > 200) continue;
    if (typeof r.tier !== "string" || !TIERS.has(r.tier)) continue;
    if (teachAppNever(r.id) || appCap(r.id).cap !== "interact") continue;
    const key = r.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      bundleId: r.id,
      name: teachText(
        typeof r.name === "string" && r.name !== "" ? r.name : displayName(r.id),
        120,
      ),
      tier: r.tier as TeachAppChoice["tier"],
    });
  }
  return out.slice(0, 200);
}

/**
 * What the helper returned, cleaned again before it reaches the review screen: only app steps in
 * the recorded app, fixed roles, one-line redacted text, and a typed example dropped (and the step
 * marked sensitive) when it looks like a card number, an ID number or a token.
 */
export function cleanAppCapture(raw: unknown, expected: { bundleId: string }): TeachAppCapture {
  const o = (raw ?? {}) as Record<string, unknown>;
  const list = Array.isArray(o.steps) ? o.steps : [];
  const steps: TeachAppCapturedStep[] = [];
  for (const item of list.slice(0, 200)) {
    const s = (item ?? {}) as Record<string, unknown>;
    const app = (s.app ?? {}) as { bundleId?: unknown; name?: unknown };
    if (typeof s.kind !== "string" || !isTeachAppKind(s.kind)) continue;
    if (
      typeof app.bundleId !== "string" ||
      app.bundleId.toLowerCase() !== expected.bundleId.toLowerCase()
    )
      continue;
    if (teachAppNever(app.bundleId)) continue;
    const base = {
      id: `a${steps.length + 1}`,
      kind: s.kind as TeachAppCapturedStep["kind"],
      app: { bundleId: app.bundleId, name: typeof app.name === "string" ? app.name : "" },
      ...(typeof s.role === "string" ? { role: s.role } : {}),
      ...(typeof s.name === "string" ? { name: s.name } : {}),
      ...(Array.isArray(s.path)
        ? { path: s.path.filter((p): p is string => typeof p === "string") }
        : {}),
      ...(typeof s.fallback === "string" ? { fallback: s.fallback } : {}),
      ...(s.sensitive === true ? { sensitive: true } : {}),
    };
    // The same cleaning every layer applies (roles from the fixed list, redacted one-line text).
    const [clean] = sanitizeTeachSteps([base]);
    if (clean === undefined) continue;
    const step: TeachAppCapturedStep = { ...clean };
    delete (step as { keepValue?: unknown }).keepValue;
    delete (step as { value?: unknown }).value;
    delete (step as { input?: unknown }).input;
    if (typeof s.sample === "string" && step.sensitive !== true && step.kind === "app_type") {
      if (classifyTeachValue(s.sample) !== null) step.sensitive = true;
      else step.sample = teachText(s.sample, 500);
    }
    steps.push(step);
  }
  const endedBy = ["stop", "limit", "timeout", "cancel", "interrupted"].includes(String(o.endedBy))
    ? (o.endedBy as TeachAppCapture["endedBy"])
    : "stop";
  const app = (o.app ?? {}) as { name?: unknown };
  return {
    id: typeof o.id === "string" ? o.id.slice(0, 64) : "app-teach",
    endedBy,
    app: {
      bundleId: expected.bundleId,
      name: teachText(
        typeof app.name === "string" ? app.name : displayName(expected.bundleId),
        120,
      ),
    },
    steps,
    skipped:
      typeof o.skipped === "number" && Number.isFinite(o.skipped)
        ? Math.max(0, Math.min(100000, Math.trunc(o.skipped)))
        : 0,
  };
}

export function composeTeachApp() {
  return (services: ComposeServices): ComposedPart => {
    let gateway: Gateway | null = null;
    let recording: { bundleId: string; deviceId: string } | undefined;

    // The desktop shell's own connection (handshake secret on loopback), never a device that only
    // says it runs macOS, and never a paired phone or a script holding an admin scope.
    const requireDesktop = (call: Call) => {
      if (call.identity.desktopShell !== true) {
        throw new PsycheError(
          "forbidden",
          "recording in a Mac app is only for the Psyche desktop app",
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
    const granted = () =>
      recordableApps(
        getSetting(services.db, COMPUTER_USE_ENABLED)?.value,
        getSetting(services.db, COMPUTER_USE_APPS)?.value,
      );

    const receipt = async (call: Call, r: NodeInvokeResult, kind: string, summary: string) => {
      const made = await call.ctx.broker.recordReceipt({
        kind,
        outcome: r.receipt?.outcome ?? "ok",
        summary,
        approvalId: null,
      });
      if (!call.ctx.brokerPublishesReceipts)
        call.ctx.bus.publish("receipt.created", { receipt: made });
    };

    const handlers: Record<string, HandlerDef> = {
      "teach.app.apps": {
        run(call: Call) {
          requireDesktop(call);
          return { apps: granted() };
        },
      },
      "teach.app.start": {
        async run(call: Call, params: { bundleId: string }) {
          requireDesktop(call);
          const bundleId = params.bundleId;
          if (!BUNDLE_ID.test(bundleId))
            throw new PsycheError("invalid_params", "not an app bundle id");
          if (teachAppNever(bundleId))
            throw new PsycheError(
              "policy_denied",
              "Psyche, security prompts and password managers are never recorded",
            );
          const choice = granted().find((a) => a.bundleId.toLowerCase() === bundleId.toLowerCase());
          if (choice === undefined)
            throw new PsycheError(
              "policy_denied",
              "that app is not allowed for computer use (Settings → Computer use)",
            );
          const node = requireNode("teach.record.start");
          const r = await node.invoke(
            "teach.record.start",
            { bundleId: choice.bundleId },
            { timeoutMs: CALL_TIMEOUT_MS },
          );
          const out = unwrap(r) as {
            sessionId?: string;
            app?: { bundleId?: string; name?: string };
          };
          recording = { bundleId: choice.bundleId, deviceId: call.identity.deviceId };
          const name = teachText(out.app?.name ?? choice.name, 120);
          await receipt(call, r, "node.teach.record", `Started recording in ${name}`);
          return {
            sessionId: String(out.sessionId ?? ""),
            app: { bundleId: choice.bundleId, name },
          };
        },
      },
      "teach.app.stop": {
        async run(call: Call) {
          requireDesktop(call);
          const node = requireNode("teach.record.stop");
          const r = await node.invoke("teach.record.stop", {}, { timeoutMs: CALL_TIMEOUT_MS });
          const raw = unwrap(r) as { app?: { bundleId?: string } };
          const bundleId = recording?.bundleId ?? raw.app?.bundleId ?? "";
          recording = undefined;
          if (!BUNDLE_ID.test(bundleId) || teachAppNever(bundleId))
            throw new PsycheError("internal", "the recording is not for a recordable app");
          const capture = cleanAppCapture(raw, { bundleId });
          await receipt(
            call,
            r,
            "node.teach.record",
            `Recorded ${capture.steps.length} steps in ${capture.app.name}`,
          );
          return capture;
        },
      },
      "teach.app.cancel": {
        async run(call: Call) {
          requireDesktop(call);
          const node = requireNode("teach.record.cancel");
          recording = undefined;
          const r = (unwrap(
            await node.invoke("teach.record.cancel", {}, { timeoutMs: CALL_TIMEOUT_MS }),
          ) ?? {}) as { cancelled?: boolean };
          return { cancelled: r.cancelled === true };
        },
      },
      "teach.app.status": {
        async run(call: Call) {
          requireDesktop(call);
          const node = dictationNode(() => gateway, "teach.record.status");
          if (!node) return { active: false } satisfies TeachAppStatus;
          const r = (unwrap(
            await node.invoke("teach.record.status", {}, { timeoutMs: CALL_TIMEOUT_MS }),
          ) ?? {}) as Record<string, unknown>;
          const app = (r.app ?? {}) as { bundleId?: unknown; name?: unknown };
          const ended = ["limit", "timeout", "cancel", "interrupted", "stop"].includes(
            String(r.ended),
          )
            ? (r.ended as TeachAppStatus["ended"])
            : undefined;
          return {
            active: r.active === true,
            ...(typeof r.sessionId === "string" ? { sessionId: r.sessionId } : {}),
            ...(typeof app.bundleId === "string"
              ? {
                  app: {
                    bundleId: app.bundleId,
                    name: teachText(typeof app.name === "string" ? app.name : "", 120),
                  },
                }
              : {}),
            ...(typeof r.steps === "number" ? { steps: Math.max(0, Math.trunc(r.steps)) } : {}),
            ...(typeof r.startedAt === "string" ? { startedAt: r.startedAt } : {}),
            ...(ended === undefined ? {} : { ended }),
          } satisfies TeachAppStatus;
        },
      },
    };

    return {
      handlers,
      start(gw) {
        gateway = gw;
      },
      stop() {
        gateway = null;
        recording = undefined;
      },
    };
  };
}
