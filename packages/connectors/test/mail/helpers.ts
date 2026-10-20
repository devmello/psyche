import type {
  PermissionBroker,
  ReceiptInput,
  ToolRegistration,
  ToolRegistry,
  ToolSpec,
} from "@psyche/protocol";
import type { LibrarySink, StoredTokens, TokenVault } from "../../src/framework/types.ts";

export class MapRegistry implements ToolRegistry {
  readonly tools = new Map<string, ToolRegistration>();
  list(): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec);
  }
  get(name: string) {
    return this.tools.get(name);
  }
  register(r: ToolRegistration) {
    this.tools.set(r.spec.name, r);
    return () => this.tools.delete(r.spec.name);
  }
}

/** Broker stub: approvals the loop already verified (id → approved binding hash), receipts recorded. */
export function stubBroker(approved: Record<string, string> = {}) {
  const receipts: ReceiptInput[] = [];
  const broker = {
    async get(id: string) {
      const bindingHash = approved[id];
      return bindingHash === undefined
        ? undefined
        : { id, status: "approved", bindingHash, requestedBy: { toolCallId: "call-approved" } };
    },
    async recordReceipt(input: ReceiptInput) {
      receipts.push(input);
      return { id: `rcpt_${receipts.length}` } as never;
    },
  } as unknown as PermissionBroker;
  return { broker, receipts, approved };
}

export class MemoryVault implements TokenVault {
  readonly tokens = new Map<string, StoredTokens>();
  async load(id: string) {
    return this.tokens.get(id);
  }
  async save(id: string, t: StoredTokens) {
    this.tokens.set(id, structuredClone(t));
  }
  async clear(id: string) {
    this.tokens.delete(id);
  }
}

export class MemoryLibrary implements LibrarySink {
  readonly items: Parameters<LibrarySink["put"]>[0][] = [];
  async put(input: Parameters<LibrarySink["put"]>[0]) {
    this.items.push(input);
    return { libraryItemId: `lib_${this.items.length}` };
  }
}

export const run = (tools: MapRegistry, name: string, params: unknown, callId = "call-1") => {
  const t = tools.get(name);
  if (t === undefined) throw new Error(`tool ${name} not registered`);
  return t.execute(callId, params, new AbortController().signal, () => {});
};
