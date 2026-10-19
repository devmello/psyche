import {
  createPairingRequest,
  decidePairingRequest,
  expirePairingRequests,
  getPairingRequest,
  type PairingRequestRow,
  type PsycheDb,
  pairingRequestFromRow,
} from "@psyche/db";
import type { Channel, ChannelIdentity, PairingRequest } from "@psyche/protocol";
import type { ChannelStore, NewChannelPairing, PairingFilter } from "./types.ts";

/**
 * `ChannelStore` on the Gateway database (`@psyche/db`, migration
 * `202610191200_channels_init.sql`). Pairing rows go through `@psyche/db`'s pairing repository.
 */

interface ChannelSqlRow {
  id: string;
  type: string;
  account: string;
  dm_policy: string;
  allow_from: string;
  group_allow_from: string;
  require_mention: number;
  owner_ids: string;
  dm_scope: string;
  node_id: string | null;
  status: string;
  config: string;
  created_at: string;
  updated_at: string;
}

interface IdentitySqlRow {
  id: string;
  display: string;
  links: string;
  delegated_persona: string | null;
  tool_allow: string | null;
  created_at: string;
  updated_at: string;
}

function channelFromRow(row: ChannelSqlRow): Channel {
  return {
    id: row.id,
    type: row.type as Channel["type"],
    account: row.account,
    dmPolicy: row.dm_policy as Channel["dmPolicy"],
    allowFrom: JSON.parse(row.allow_from) as string[],
    groupAllowFrom: JSON.parse(row.group_allow_from) as string[],
    requireMention: row.require_mention === 1,
    ownerIds: JSON.parse(row.owner_ids) as string[],
    dmScope: row.dm_scope as Channel["dmScope"],
    nodeId: row.node_id,
    status: row.status as Channel["status"],
    config: JSON.parse(row.config) as Channel["config"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function identityFromRow(row: IdentitySqlRow): ChannelIdentity {
  return {
    id: row.id,
    display: row.display,
    links: JSON.parse(row.links) as string[],
    delegatedPersona: row.delegated_persona,
    toolAllow: row.tool_allow === null ? null : (JSON.parse(row.tool_allow) as string[]),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PairingSqlRow {
  id: string;
  kind: string;
  code: string;
  device_id: string | null;
  channel_id: string | null;
  sender_id: string | null;
  display: string;
  status: string;
  expires_at: string;
  decided_at: string | null;
  decided_by_device_id: string | null;
  public_key_fingerprint?: string | null;
  transport?: string | null;
  remote_address?: string | null;
  created_at: string;
  updated_at: string;
}

function pairingFromSql(row: PairingSqlRow): PairingRequest {
  const drizzleRow: PairingRequestRow = {
    id: row.id,
    kind: row.kind,
    code: row.code,
    deviceId: row.device_id,
    channelId: row.channel_id,
    senderId: row.sender_id,
    display: row.display,
    status: row.status,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedByDeviceId: row.decided_by_device_id,
    publicKeyFingerprint: row.public_key_fingerprint ?? null,
    transport: row.transport ?? null,
    remoteAddress: row.remote_address ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return pairingRequestFromRow(drizzleRow);
}

export class SqliteChannelStore implements ChannelStore {
  #db: PsycheDb;

  constructor(db: PsycheDb) {
    this.#db = db;
  }

  async listChannels(): Promise<Channel[]> {
    const rows = this.#db.sqlite
      .prepare("SELECT * FROM channels ORDER BY created_at, id")
      .all() as ChannelSqlRow[];
    return rows.map(channelFromRow);
  }

  async getChannel(id: string): Promise<Channel | undefined> {
    const row = this.#db.sqlite.prepare("SELECT * FROM channels WHERE id = ?").get(id) as
      | ChannelSqlRow
      | undefined;
    return row === undefined ? undefined : channelFromRow(row);
  }

  async saveChannel(channel: Channel): Promise<Channel> {
    this.#db.sqlite
      .prepare(
        `INSERT INTO channels (id, type, account, dm_policy, allow_from, group_allow_from,
           require_mention, owner_ids, dm_scope, node_id, status, config, created_at, updated_at)
         VALUES (@id, @type, @account, @dmPolicy, @allowFrom, @groupAllowFrom, @requireMention,
           @ownerIds, @dmScope, @nodeId, @status, @config, @createdAt, @updatedAt)
         ON CONFLICT (id) DO UPDATE SET account = excluded.account, dm_policy = excluded.dm_policy,
           allow_from = excluded.allow_from, group_allow_from = excluded.group_allow_from,
           require_mention = excluded.require_mention, owner_ids = excluded.owner_ids,
           dm_scope = excluded.dm_scope, node_id = excluded.node_id, status = excluded.status,
           config = excluded.config, updated_at = excluded.updated_at`,
      )
      .run({
        id: channel.id,
        type: channel.type,
        account: channel.account,
        dmPolicy: channel.dmPolicy,
        allowFrom: JSON.stringify(channel.allowFrom),
        groupAllowFrom: JSON.stringify(channel.groupAllowFrom),
        requireMention: channel.requireMention ? 1 : 0,
        ownerIds: JSON.stringify(channel.ownerIds),
        dmScope: channel.dmScope,
        nodeId: channel.nodeId,
        status: channel.status,
        config: JSON.stringify(channel.config),
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
      });
    const saved = await this.getChannel(channel.id);
    if (saved === undefined) throw new Error(`channel ${channel.id} vanished`);
    return saved;
  }

  async listIdentities(): Promise<ChannelIdentity[]> {
    const rows = this.#db.sqlite
      .prepare("SELECT * FROM identities ORDER BY created_at, id")
      .all() as IdentitySqlRow[];
    return rows.map(identityFromRow);
  }

  async saveIdentity(identity: ChannelIdentity): Promise<ChannelIdentity> {
    this.#db.sqlite
      .prepare(
        `INSERT INTO identities (id, display, links, delegated_persona, tool_allow, created_at, updated_at)
         VALUES (@id, @display, @links, @delegatedPersona, @toolAllow, @createdAt, @updatedAt)
         ON CONFLICT (id) DO UPDATE SET display = excluded.display, links = excluded.links,
           delegated_persona = excluded.delegated_persona, tool_allow = excluded.tool_allow,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: identity.id,
        display: identity.display,
        links: JSON.stringify(identity.links),
        delegatedPersona: identity.delegatedPersona,
        toolAllow: identity.toolAllow === null ? null : JSON.stringify(identity.toolAllow),
        createdAt: identity.createdAt,
        updatedAt: identity.updatedAt,
      });
    const row = this.#db.sqlite.prepare("SELECT * FROM identities WHERE id = ?").get(identity.id) as
      | IdentitySqlRow
      | undefined;
    if (row === undefined) throw new Error(`identity ${identity.id} vanished`);
    return identityFromRow(row);
  }

  async deleteIdentity(id: string): Promise<boolean> {
    return this.#db.sqlite.prepare("DELETE FROM identities WHERE id = ?").run(id).changes > 0;
  }

  async createPairing(input: NewChannelPairing): Promise<PairingRequest> {
    return createPairingRequest(this.#db, {
      kind: "channel-sender",
      code: input.code,
      channelId: input.channelId,
      senderId: input.senderId,
      display: input.display,
      expiresAt: input.expiresAt,
    });
  }

  async getPairing(id: string): Promise<PairingRequest | undefined> {
    return getPairingRequest(this.#db, id);
  }

  async listPairings(filter: PairingFilter = {}): Promise<PairingRequest[]> {
    const where = ["kind = 'channel-sender'"];
    const args: string[] = [];
    if (filter.channelId !== undefined) {
      where.push("channel_id = ?");
      args.push(filter.channelId);
    }
    if (filter.status !== undefined) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.senderId !== undefined) {
      where.push("sender_id = ?");
      args.push(filter.senderId);
    }
    const rows = this.#db.sqlite
      .prepare(
        `SELECT * FROM pairing_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`,
      )
      .all(...args) as PairingSqlRow[];
    return rows.map(pairingFromSql);
  }

  async decidePairing(
    id: string,
    decision: "approved" | "denied",
    decidedByDeviceId: string | null,
  ): Promise<PairingRequest> {
    return decidePairingRequest(this.#db, id, { decision, decidedByDeviceId });
  }

  async expirePairings(nowIso: string): Promise<number> {
    return expirePairingRequests(this.#db, nowIso);
  }
}
