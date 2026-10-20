import { createHash } from "node:crypto";
import type { SecretSource } from "@psyche/channels";
import {
  type ChannelType,
  type MethodParams,
  type MethodResult,
  PsycheError,
} from "@psyche/protocol";
import type { Vault } from "@psyche/vault";
import type { Call, HandlerDef } from "../context.ts";

/**
 * Channel transport secrets (N8, N9; `channels.secrets.*`): Slack's bot and app tokens, Discord's
 * bot token, the SMS provider's auth token. Each is a Gateway-owned vault item, like a model key
 * (`model-keys.ts`): bound to its owner id, refused to every agent fill (`connector_owned`), and
 * read by the adapter inside `ResolvedSecret.use` per connection or request, so it never sits in
 * an adapter, a log or a transcript.
 */

export type ChannelSecretName = MethodParams<"channels.secrets.set">["name"];

/** The secrets each channel type needs from the vault. */
export const CHANNEL_SECRETS: Partial<Record<ChannelType, readonly ChannelSecretName[]>> = {
  slack: ["bot_token", "app_token"],
  discord: ["bot_token"],
  sms: ["auth_token"],
};

/** The owner id (and slug) of one secret: `channel-slack-<account digest>-bot-token`. */
export function channelSecretOwner(
  type: ChannelType,
  account: string,
  name: ChannelSecretName,
): string {
  const digest = createHash("sha256").update(account, "utf8").digest("hex").slice(0, 12);
  return `channel-${type}-${digest}-${name.replace("_", "-")}`;
}

function required(type: ChannelType, name?: ChannelSecretName): readonly ChannelSecretName[] {
  const names = CHANNEL_SECRETS[type] ?? [];
  if (name !== undefined && !names.includes(name)) {
    throw new PsycheError("invalid_params", `${type} channels do not use the secret ${name}`);
  }
  return names;
}

export function storedChannelSecrets(
  vault: Vault,
  type: ChannelType,
  account: string,
): ChannelSecretName[] {
  return (CHANNEL_SECRETS[type] ?? []).filter(
    (n) => vault.connectorItem(channelSecretOwner(type, account, n)) !== undefined,
  );
}

/** Stores (or replaces) one secret as a Gateway-owned item. */
export async function storeChannelSecret(
  vault: Vault,
  type: ChannelType,
  account: string,
  name: ChannelSecretName,
  value: string,
): Promise<void> {
  required(type, name);
  const owner = channelSecretOwner(type, account, name);
  const existing = vault.connectorItem(owner);
  if (existing !== undefined) {
    await vault.replaceConnectorTokens(existing.id, owner, { accessToken: value });
    return;
  }
  await vault.store({
    connectorId: owner,
    slug: owner,
    name: `${type} ${name.replace("_", " ")} (${account})`,
    bindings: [{ connector: owner }],
    tokens: { accessToken: value },
  });
}

/** A `SecretSource` over one stored secret; a locked vault is unlocked on first use. */
export function vaultChannelSecret(
  vault: () => Vault | undefined,
  type: ChannelType,
  account: string,
  name: ChannelSecretName,
): SecretSource {
  const owner = channelSecretOwner(type, account, name);
  return {
    async use<T>(fn: (value: string) => Promise<T>): Promise<T> {
      const v = vault();
      const item = v?.connectorItem(owner);
      if (v === undefined || item === undefined) {
        throw new PsycheError(
          "unavailable",
          `no ${type} ${name} yet: add it in Settings → Channels`,
          {
            details: { reason: "channel_secret_missing", type, name },
          },
        );
      }
      if (v.locked) {
        try {
          await v.unlock(`Connect ${type}`);
        } catch {
          throw new PsycheError("unavailable", "the vault is locked", {
            details: { reason: "vault_locked" },
          });
        }
      }
      const secret = await v.accessToken(item.id, owner);
      return secret.use(fn);
    },
  };
}

/** `channels.secrets.set` / `channels.secrets.status`. Never echoes or logs a value. */
export function channelSecretHandlers(
  vault: () => Vault | undefined,
  onStored: (type: ChannelType, account: string) => void = () => undefined,
): Record<string, HandlerDef> {
  const open = (): Vault => {
    const v = vault();
    if (v === undefined) throw new PsycheError("unavailable", "the vault is not set up");
    return v;
  };
  return {
    "channels.secrets.set": {
      async run(
        _call: Call,
        params: MethodParams<"channels.secrets.set">,
      ): Promise<MethodResult<"channels.secrets.set">> {
        const v = open();
        try {
          await storeChannelSecret(v, params.type, params.account, params.name, params.value);
        } catch (err) {
          // A raw error could quote its input: only the vault's own errors pass through.
          if (err instanceof PsycheError && err.code !== "internal") throw err;
          throw new PsycheError("unavailable", "the secret could not be stored");
        }
        onStored(params.type, params.account);
        return { set: storedChannelSecrets(v, params.type, params.account) };
      },
    },
    "channels.secrets.status": {
      async run(
        _call: Call,
        params: MethodParams<"channels.secrets.status">,
      ): Promise<MethodResult<"channels.secrets.status">> {
        const v = vault();
        return {
          required: [...required(params.type)],
          set: v === undefined ? [] : storedChannelSecrets(v, params.type, params.account),
        };
      },
    },
  };
}
