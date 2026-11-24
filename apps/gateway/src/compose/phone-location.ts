import { type AgentToolRegistration, defineTool } from "@psyche/agent-core";
import { PhoneLocation, type ToolResult } from "@psyche/protocol";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { NodeRegistry } from "../nodes/registry.ts";

/**
 * `location_current`: where the owner's phone is right now (docs/design/mobile-companion-2026.md
 * §4, M3). One fix per call over the phone's `location.current` capability, which the phone offers
 * only while the owner has switched "Share location with Psyche" on and the app is open.
 *
 * - **A read, no approval card.** The owner's switch on the phone is the consent; the call shows in
 *   the task's Activity like every tool call (`describeCall`). Nothing here asks for Touch ID or
 *   limits how often it runs.
 * - **Never remembered.** The Gateway keeps no trail: the fix goes to the run that asked and its
 *   trace, and the logger never sees the coordinates.
 * - **Never sent to a third party** by this tool. It does reach the thread's own model as a tool
 *   result, like any tool output; the phone's switch says so.
 * - **Failure is plain text** the agent can relay ("The phone isn't sharing location right now").
 */

/** How long one fix may take on the phone (cold GPS start included). */
export const LOCATION_TIMEOUT_MS = 20_000;

export const PHONE_NOT_SHARING =
  "The phone isn't sharing location right now. Ask the owner to open Psyche on the phone and switch on Share location with Psyche in Settings.";

export interface PhoneLocationDeps {
  readonly nodes: () => NodeRegistry | undefined;
  readonly now?: () => number;
}

/** Control, format, bidirectional and line-break characters out; spaces collapsed; cut. */
export function cleanPlaceName(raw: string): string {
  return raw
    .replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const failure = (code: string, message: string): ToolResult => ({
  output: { error: { code, message } },
  isError: true,
  provenance: "trusted",
});

export function phoneLocationTool(deps: PhoneLocationDeps): AgentToolRegistration {
  const now = deps.now ?? Date.now;
  return defineTool({
    name: "location_current",
    description:
      "Get the owner's current location from their phone: latitude, longitude, accuracy in metres, when the fix was taken and a place name. Use it for 'where am I', 'what's near me' and 'how long to get home'. It works only while the owner has switched on location sharing on the phone and has Psyche open there; otherwise it returns an error you can relay as it is.",
    input: Type.Object({}, { additionalProperties: false }),
    sideEffect: "read",
    describeCall: () => ({ summary: "Checked where the phone is" }),
    async run(_p, ctx) {
      const phone = deps.nodes()?.phone("location.current");
      if (phone === undefined) return failure("unavailable", PHONE_NOT_SHARING);
      const res = await phone.client.invoke(
        "location.current",
        {},
        { timeoutMs: LOCATION_TIMEOUT_MS, signal: ctx.signal },
      );
      if (!res.ok) {
        const code = res.error?.code ?? "unavailable";
        // The phone's own message is what the owner should read ("Location permission is off").
        return failure(
          code,
          code === "timeout"
            ? "The phone didn't answer in time."
            : (res.error?.message ?? PHONE_NOT_SHARING),
        );
      }
      if (!Value.Check(PhoneLocation, res.result)) {
        return failure("bad_response", "The phone sent a location the Gateway could not read.");
      }
      const fix = res.result;
      const takenAt = Date.parse(fix.timestamp);
      const placeName = fix.placeName === undefined ? "" : cleanPlaceName(fix.placeName);
      return {
        output: {
          latitude: fix.latitude,
          longitude: fix.longitude,
          accuracyMeters: Math.round(fix.accuracyMeters),
          timestamp: fix.timestamp,
          ...(Number.isNaN(takenAt)
            ? {}
            : { ageSeconds: Math.max(0, Math.round((now() - takenAt) / 1000)) }),
          ...(placeName === "" ? {} : { placeName }),
        },
        // A place name is text from a map database (a shop can name itself anything), so a reply
        // that carries one taints the turn; bare coordinates are the phone's own numbers.
        provenance: placeName === "" ? "trusted" : "untrusted",
      };
    },
  });
}
