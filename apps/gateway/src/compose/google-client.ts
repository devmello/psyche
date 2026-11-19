import { getSetting, setSetting } from "@psyche/db";
import { type MethodResult, PsycheError } from "@psyche/protocol";
import { googleClientFrom } from "../config.ts";
import type { Call, HandlerDef } from "../context.ts";
import type { ComposeServices } from "./services.ts";

/**
 * The owner's own Google OAuth client (Desktop app), pasted in Settings → Connectors. There is
 * no Psyche-owned client (docs/02-architecture.md, docs/guides/connectors-google.md).
 *
 * - The client id is not a secret: it is an internal, sealed setting (`_` prefix, so
 *   `settings.get` and `settings.set` never see it).
 * - The client secret is a vault item (slug `google-oauth-client`, bound to Google's token
 *   endpoint, the same item the guide's `psyche vault add` makes). Only its `{{cred:slug}}`
 *   placeholder is ever stored or passed on; reading it later is the connector's credential
 *   approval. An item of the owner's that happens to hold the slug is never written to: the secret
 *   goes to a fresh slug instead.
 * - A client set in `config.json` or the environment wins, and Settings cannot overwrite it.
 * - Changing the client id while Google is connected with another client is refused: the live
 *   connection keeps refreshing with its own id, so it must be disconnected first.
 */
export const GOOGLE_CLIENT_SETTING = "_connectors.googleClient";
export const GOOGLE_CLIENT_SLUG = "google-oauth-client";
const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";

export interface GoogleClient {
  clientId?: string;
  clientSecret?: string;
}
type Status = MethodResult<"connectors.googleClient">;

const slugOf = (placeholder: string | undefined): string | undefined =>
  /^\{\{cred:([a-z0-9][a-z0-9-]*)\}\}$/.exec(placeholder ?? "")?.[1];

export function googleClientStore(
  services: ComposeServices,
  fromConfig: GoogleClient,
  audit: (call: Call, kind: string, data: Record<string, unknown>) => Promise<void>,
  /** Client ids of the Google connections that exist now (connected or not). */
  connectionClientIds: () => Promise<readonly (string | undefined)[]>,
) {
  const stored = (): GoogleClient => {
    const v = getSetting(services.db, GOOGLE_CLIENT_SETTING)?.value;
    if (v === null || typeof v !== "object") return {};
    // Re-validated on every read: a hand-edited row cannot smuggle a raw secret through.
    try {
      return googleClientFrom(v, GOOGLE_CLIENT_SETTING);
    } catch {
      return {};
    }
  };
  const fromFile = fromConfig.clientId !== undefined && fromConfig.clientId !== "";
  /** What a Google connect uses: config.json / environment first, else what Settings saved. */
  const resolve = (): GoogleClient => (fromFile ? fromConfig : stored());
  const status = (): Status => {
    const c = resolve();
    const clientId = c.clientId;
    const configured = clientId !== undefined && clientId !== "";
    return {
      configured,
      ...(configured ? { clientId } : {}),
      hasSecret: c.clientSecret !== undefined,
      source: configured ? (fromFile ? "config" : "app") : null,
    };
  };
  /** An item this feature made: an API key bound to exactly Google's token endpoint. */
  const ours = (slug: string) => {
    const item = services.vault.metaBySlug(slug);
    return item !== undefined &&
      item.kind === "api_key" &&
      item.ownerConnectorId === null &&
      item.bindings.length === 1 &&
      (item.bindings[0] as { origin?: string }).origin === GOOGLE_TOKEN_ORIGIN
      ? item
      : undefined;
  };
  /** The slug to write to: our own item's, else the first free `google-oauth-client[-n]`. */
  const slugFor = (current: string | undefined): string => {
    if (current !== undefined && ours(current) !== undefined) return current;
    for (let i = 1; ; i++) {
      const slug = i === 1 ? GOOGLE_CLIENT_SLUG : `${GOOGLE_CLIENT_SLUG}-${i}`;
      if (services.vault.metaBySlug(slug) === undefined || ours(slug) !== undefined) return slug;
    }
  };

  const handlers: Record<string, HandlerDef> = {
    "connectors.googleClient": { run: () => status() },
    "connectors.googleClient.set": {
      async run(call: Call, params: { clientId: string; clientSecret?: string }) {
        if (fromFile) {
          throw new PsycheError(
            "conflict",
            "The Google client is set in config.json or the environment; change it there.",
            { details: { reason: "client_from_config" } },
          );
        }
        // Same shape check as config.json. The message never echoes the secret.
        const checked = googleClientFrom({ clientId: params.clientId.trim() }, "clientId");
        const clientId = checked.clientId as string;
        const secret = params.clientSecret?.trim();
        const secretGiven = secret !== undefined && secret !== "";
        const current = stored();
        const idChanged = current.clientId !== undefined && current.clientId !== clientId;
        if ((await connectionClientIds()).some((id) => id !== undefined && id !== clientId)) {
          throw new PsycheError(
            "conflict",
            "Google is connected with another client. Disconnect Google first, then change the client.",
            { details: { reason: "connected_with_other_client" } },
          );
        }
        // A new client id never inherits the old client's secret.
        if (idChanged && current.clientSecret !== undefined && !secretGiven) {
          throw new PsycheError(
            "invalid_params",
            "A different client needs its own client secret.",
            { details: { reason: "secret_required" } },
          );
        }
        let placeholder = idChanged ? undefined : current.clientSecret;
        if (secretGiven) {
          const slug = slugFor(slugOf(current.clientSecret));
          const existing = ours(slug);
          if (existing !== undefined) {
            await services.vault.update(existing.id, { secret: { token: secret } });
          } else {
            await services.vault.add({
              kind: "api_key",
              name:
                slug === GOOGLE_CLIENT_SLUG
                  ? "Google OAuth client"
                  : `Google OAuth client (${slug})`,
              slug,
              bindings: [{ origin: GOOGLE_TOKEN_ORIGIN }],
              secret: { token: secret },
            });
          }
          placeholder = `{{cred:${slug}}}`;
        }
        setSetting(services.db, GOOGLE_CLIENT_SETTING, {
          clientId,
          ...(placeholder === undefined ? {} : { clientSecret: placeholder }),
        });
        await audit(call, "connector.google_client_set", {
          clientId,
          secretChanged: secretGiven,
        });
        return { status: status() };
      },
    },
  };
  return { resolve, status, handlers };
}
