import type { NodeCapability, NodeInfo, NodeKind, NodeStatus } from "@psyche/protocol";
import { asc, eq } from "drizzle-orm";
import { nodeFromRow } from "../mappers.ts";
import type { PsycheDb } from "../open.ts";
import { nodes } from "../schema.ts";

export interface NodeUpsert {
  readonly id: string;
  readonly deviceId: string;
  readonly kind: NodeKind;
  readonly capabilities: readonly NodeCapability[];
  readonly status: NodeStatus;
  readonly lastHeartbeatAt?: string | null;
}

export function upsertNode(db: PsycheDb, input: NodeUpsert): NodeInfo {
  const at = db.now();
  const values = {
    deviceId: input.deviceId,
    kind: input.kind,
    capabilities: JSON.stringify(input.capabilities),
    status: input.status,
    lastHeartbeatAt: input.lastHeartbeatAt ?? at,
    updatedAt: at,
  };
  const row = db.drizzle
    .insert(nodes)
    .values({ id: input.id, ...values, createdAt: at })
    .onConflictDoUpdate({ target: nodes.id, set: values })
    .returning()
    .get();
  return nodeFromRow(row);
}

export function getNode(db: PsycheDb, id: string): NodeInfo | undefined {
  const row = db.drizzle.select().from(nodes).where(eq(nodes.id, id)).get();
  return row === undefined ? undefined : nodeFromRow(row);
}

export function getNodeByDevice(db: PsycheDb, deviceId: string): NodeInfo | undefined {
  const row = db.drizzle.select().from(nodes).where(eq(nodes.deviceId, deviceId)).get();
  return row === undefined ? undefined : nodeFromRow(row);
}

export function listNodes(db: PsycheDb): NodeInfo[] {
  return db.drizzle.select().from(nodes).orderBy(asc(nodes.createdAt)).all().map(nodeFromRow);
}

export function setNodeStatus(db: PsycheDb, id: string, status: NodeStatus): NodeInfo | undefined {
  const row = db.drizzle
    .update(nodes)
    .set({ status, updatedAt: db.now() })
    .where(eq(nodes.id, id))
    .returning()
    .get();
  return row === undefined ? undefined : nodeFromRow(row);
}

/** Boot: no node is connected yet. */
export function markAllNodesOffline(db: PsycheDb): number {
  return db.drizzle.update(nodes).set({ status: "offline", updatedAt: db.now() }).run().changes;
}
