import { getSetting, setSetting } from "@psyche/db";
import { type MethodResult, PsycheError } from "@psyche/protocol";
import { googleClientFrom } from "../config.ts";
import type { Call, HandlerDef } from "../context.ts";
import type { ComposeServices } from "./services.ts";

/**
 * The owner's own Google OAuth client (Desktop app), pasted in Settings → Connectors. There is
 * no Psyche-owned client (docs/02-architecture.md, docs/guides/connectors-google.md).
 *
 * - The client id is not a secret: it is an internal setting (`_` prefix, so `settings.get` and
 *   `settings.set` never see it).
 * - The client secret is a vault item (`google-oauth-client`, bound to Google's token endpoint,
 *   the same item the guide's `psyche vault add` makes). Only its `{{cred:slug}}` placeholder is
 *   ever stored or passed on; reading it later is the connector's credential approval.
 * - A client set in `config.json` or the environment wins, and Settings cannot overwrite it.
 */
export const GOOGLE_CLIENT_SETTING = "_connectors.googleClient";
export const GOOGLE_CLIENT_SLUG = "google-oauth-client";
const GOOGLE_TOKEN_ORIGIN = "https://oauth2.googleapis.com";

export interface GoogleClient {
  clientId?: string;
  clientSecret?: string;
}
type Status = MethodResult<"connectors.googleClient">;

export function googleClientStore(
  services: ComposeServices,
  fromConfig: GoogleClient,
  audit: (kind: string, data: Record<string, unknown>) => Promise<void>,
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

  const handlers: Record<string, HandlerDef> = {
    "connectors.googleClient": { run: () => status() },
    "connectors.googleClient.set": {
      async run(_call: Call, params: { clientId: string; clientSecret?: string }) {
        if (fromFile) {
          throw new PsycheError(
            "conflict",
            "The Google client is set in config.json or the environment; change it there.",
            { details: { reason: "client_from_config" } },
          );
        }
        // Same shape check as config.json. The message never echoes the secret.
        const checked = googleClientFrom({ clientId: params.clientId.trim() }, "clientId");
        const secret = params.clientSecret?.trim();
        const secretGiven = secret !== undefined && secret !== "";
        let placeholder = stored().clientSecret;
        if (secretGiven) {
          const existing = services.vault.metaBySlug(GOOGLE_CLIENT_SLUG);
          if (existing === undefined) {
            await services.vault.add({
              kind: "api_key",
              name: "Google OAuth client",
              slug: GOOGLE_CLIENT_SLUG,
              bindings: [{ origin: GOOGLE_TOKEN_ORIGIN }],
              secret: { token: secret },
            });
          } else if (existing.ownerConnectorId === null) {
            await services.vault.update(existing.id, { secret: { token: secret } });
          } else {
            throw new PsycheError("conflict", "The vault slug google-oauth-client is taken.", {
              details: { reason: "slug_taken" },
            });
          }
          placeholder = `{{cred:${GOOGLE_CLIENT_SLUG}}}`;
        }
        setSetting(services.db, GOOGLE_CLIENT_SETTING, {
          clientId: checked.clientId,
          ...(placeholder === undefined ? {} : { clientSecret: placeholder }),
        });
        await audit("connector.google_client_set", {
          clientId: checked.clientId ?? "",
          secretChanged: secretGiven,
        });
        return { status: status() };
      },
    },
  };
  return { resolve, status, handlers };
}
