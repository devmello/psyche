import {
  type ConnectorRecord,
  ownerContent,
  readTrustedSources,
  type SourceFact,
  sourceFacts,
  type TrustContext,
  toolName,
} from "@psyche/connectors";
import type { GraphStore } from "@psyche/memory";
import type { AppleSourceDeps, HelperCall, ToolCall } from "@psyche/search";
import { graphDocId } from "@psyche/search";
import { helperFailure, type MessagesHelper, type SourceDeps } from "./people-sources.ts";

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
  /**
   * The Host's Mac helper offering `contacts.list` and `contacts.read` (`NodeRegistry.hostHelper`,
   * the trusted in-process path; never the client-facing `nodes.invoke`).
   */
  contacts?: () => MessagesHelper | undefined;
  /** The people graph, when memory is on: a contact that is a known person collapses onto them. */
  graph?: () => Pick<GraphStore, "resolveIdentifier" | "getEntity"> | undefined;
  now: () => number;
}): AppleSearchSeams {
  let records: ConnectorRecord[] = [];
  const record = (app: App) =>
    records.find((r) => r.type === `apple:${app}` && r.status === "connected");
  const trust = new Map<string, TrustContext>();

  const helperCall = (client: MessagesHelper): HelperCall => {
    return async (capability, params, signal) => {
      const res = await client.invoke(capability, params, { signal, timeoutMs: 30_000 });
      if (!res.ok) throw new Error(helperFailure(capability, res.error));
      return res.result;
    };
  };

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
      return client === undefined ? undefined : helperCall(client);
    },
    contacts: () => {
      const client = o.contacts?.();
      return client === undefined ? undefined : helperCall(client);
    },
    contactParent: (contact) => contactParent(o.graph?.(), contact),
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

/**
 * The Memory person document a contact is the same person as, matched only by the Apple contact id
 * the people graph recorded when it read the owner's address book. Never by email or number: those
 * are also learned from other people's mail, which could claim an address to pull a contact under
 * a person it is not. Only an active, visible person: a hidden ("don't track") or private one has
 * no document to collapse onto.
 */
export function contactParent(
  graph: Pick<GraphStore, "resolveIdentifier" | "getEntity"> | undefined,
  contact: { id: string },
): string | undefined {
  if (graph === undefined) return undefined;
  const id = graph.resolveIdentifier("contact", contact.id);
  if (id === undefined) return undefined;
  const e = graph.getEntity(id);
  return e !== undefined &&
    e.kind === "person" &&
    e.status === "active" &&
    !e.hidden &&
    e.private !== true
    ? graphDocId(e.id)
    : undefined;
}
