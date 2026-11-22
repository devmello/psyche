import type { ConnectorRecord } from "@psyche/connectors";
import { appleAdapters } from "@psyche/search";
import { describe, expect, it } from "vitest";
import { appleSearchSeams } from "../src/compose/search-apple.ts";

const mailRecord = {
  id: "apple-mail",
  type: "apple:mail",
  status: "connected",
} as unknown as ConnectorRecord;

const noTools = { get: () => undefined } as never;

async function seams(opts: {
  helperOnline: () => boolean;
  contacts?: () => { invoke: (...args: unknown[]) => Promise<unknown> } | undefined;
  onContactsDenied?: (denied: boolean) => void;
}) {
  const s = appleSearchSeams({
    connectors: async () => [mailRecord],
    tools: noTools,
    messages: () => undefined,
    helperOnline: opts.helperOnline,
    ...(opts.contacts === undefined ? {} : { contacts: opts.contacts as never }),
    ...(opts.onContactsDenied === undefined ? {} : { onContactsDenied: opts.onContactsDenied }),
    now: () => 0,
  });
  await s.refresh();
  return s;
}

describe("Apple search seams with the Host helper offline", () => {
  it("withholds the Apple app's reads while the helper is offline", async () => {
    let online = false;
    const s = await seams({ helperOnline: () => online });
    expect(s.deps.call("mail")).toBeUndefined();
    online = true;
    expect(s.deps.call("mail")).toBeTypeOf("function");
  });

  it("says the helper is not connected, not that the app is unconnected", async () => {
    const s = await seams({ helperOnline: () => false });
    const mail = appleAdapters(s.deps).find((a) => a.id === "mail");
    expect(mail?.unavailable()).toBe("the Mac helper is not connected");
  });

  it("reports a Contacts permission refusal, and its clearing", async () => {
    const reports: boolean[] = [];
    let answer: { ok: boolean; error?: unknown; result?: unknown } = {
      ok: false,
      error: {
        code: "permission_missing",
        message: "Psyche (Helper) does not have the Contacts permission",
      },
    };
    const s = await seams({
      helperOnline: () => true,
      contacts: () => ({ invoke: async () => answer }),
      onContactsDenied: (d) => reports.push(d),
    });
    const call = s.deps.contacts?.();
    expect(call).toBeTypeOf("function");
    await expect(call?.("contacts.list", {}, new AbortController().signal)).rejects.toThrow(
      /Contacts permission/,
    );
    answer = { ok: true, result: { contacts: [] } };
    await call?.("contacts.list", {}, new AbortController().signal);
    expect(reports).toEqual([true, false]);
  });
});
