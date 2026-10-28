import {
  type ConnectorRecord,
  ownerContent,
  readTrustedSources,
  type SourceFact,
  sourceFacts,
  type TrustContext,
  toolName,
} from "@psyche/connectors";
import type { AppleSourceDeps, HelperCall, ToolCall } from "@psyche/search";
import type { MessagesHelper, SourceDeps } from "./people-sources.ts";

/**
 * The seams the Apple search sources read through: the Apple connector's tools (one record per
 * app) and the Mac helper's Messages read. Nothing here opens Mail, Messages or chat.db itself.
 */

type App = "mail" | "notes" | "calendar" | "reminders";
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const FACT_TOOL = {
  notes: "notes_folders",
  calendar: "calendar_list_calendars",
  reminders: "reminders_list_lists",
} as const;

export interface AppleSearchSeams {
  deps: AppleSourceDeps;
  /** Re-reads the connector list; call before each pass (the deps themselves are synchronous). */
  refresh(): Promise<void>;
}

export function appleSearchSeams(o: {
  connectors: SourceDeps["connectors"];
  tools: SourceDeps["tools"];
  messages: () => MessagesHelper | undefined;
  now: () => number;
}): AppleSearchSeams {
  let records: ConnectorRecord[] = [];
  const record = (app: App) =>
    records.find((r) => r.type === `apple:${app}` && r.status === "connected");
  const trust = new Map<string, TrustContext>();

  const callFor = (rec: ConnectorRecord): ToolCall => {
    return async (tool, params, signal) => {
      const reg = o.tools.get(toolName(rec.id, tool));
      if (reg === undefined) throw new Error(`${tool} is not available`);
      const res = await reg.execute(
        `search:${rec.id}:${tool}:${o.now()}`,
        params,
        signal,
        () => {},
      );
      if (res.isError === true) throw new Error(`${tool} failed`);
      return res.output;
    };
  };

  const deps: AppleSourceDeps = {
    call: (app) => {
      const rec = record(app);
      return rec === undefined ? undefined : callFor(rec);
    },
    helper: () => {
      const client = o.messages();
      if (client === undefined) return undefined;
      const call: HelperCall = async (capability, params, signal) => {
        const res = await client.invoke(capability, params, { signal, timeoutMs: 30_000 });
        if (!res.ok) throw new Error(`${capability} failed: ${res.error?.code ?? "unknown"}`);
        return res.result;
      };
      return call;
    },
    ownAddresses: () =>
      records.flatMap((r) => (r.account !== null && EMAIL.test(r.account) ? [r.account] : [])),
    refreshTrust: async (app, signal) => {
      const rec = record(app);
      if (rec === undefined) return;
      const trusted = readTrustedSources(rec.config);
      const facts = new Map<string, SourceFact>();
      if (trusted.size > 0) {
        try {
          for (const f of sourceFacts(app, await callFor(rec)(FACT_TOOL[app], {}, signal)))
            facts.set(f.id, f);
        } catch {
          // Unresolved sources stay untrusted.
        }
      }
      trust.set(app, { trusted, facts });
    },
    // #1006: the owner's trusted lists and attested-unshared rows are owner content; all else is not.
    owned: (app, row) => {
      const ctx = trust.get(app);
      return ctx !== undefined && ownerContent(app, [row], ctx);
    },
    now: o.now,
  };
  return {
    deps,
    refresh: async () => {
      records = await o.connectors();
    },
  };
}
