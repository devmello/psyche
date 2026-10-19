import {
  type CredentialBroker,
  PsycheError,
  type ResolvedSecret,
  type Target,
} from "@psyche/protocol";
import type { AuthProfile } from "./config.ts";

/**
 * Stand-in API key handed to provider packages. It never leaves the process: the fetch
 * wrapper swaps it for the real key inside `ResolvedSecret.use` just before the request goes
 * out, so the key is never stored in a provider object, config, log or error.
 */
export const KEY_SENTINEL = "psyche-key-injected-at-fetch";

/** Where provider keys come from. The default is the vault (`brokerKeySource`). */
export interface KeySource {
  /** Resolve the profile's key for a request to `target` (the request's origin). */
  resolve(profile: AuthProfile, target: Target, signal?: AbortSignal): Promise<ResolvedSecret | undefined>;
  /** Scrub known secret values from text bound for errors or logs. */
  redact(text: string): string;
}

/**
 * Keys from the Credential Broker. The vault checks that the item is bound to the request
 * origin and that the profile's approval is a live `credential_fill` grant (security §4.5).
 */
export function brokerKeySource(broker: CredentialBroker): KeySource {
  return {
    async resolve(profile, target, signal) {
      if (profile.credential === undefined) return undefined;
      if (profile.approvalId === undefined) {
        throw new PsycheError(
          "approval_required",
          `auth profile "${profile.id}" has no credential_fill grant for its key`,
        );
      }
      const opts: { executor: "connector"; signal?: AbortSignal } = { executor: "connector" };
      if (signal !== undefined) opts.signal = signal;
      return broker.resolve(profile.credential, target, profile.approvalId, opts);
    },
    redact: (text) => broker.redact(text),
  };
}

/** No keys (local servers only). */
export const NO_KEYS: KeySource = {
  resolve: async () => undefined,
  redact: (text) => text,
};

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Wrap `fetch` so the sentinel key in any header is replaced by the profile's real key,
 * resolved for this request's origin. When the profile has no key the header is dropped.
 */
export function keyInjectingFetch(
  base: typeof fetch,
  keys: KeySource,
  profile: AuthProfile | undefined,
): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    let keyHeader: string | undefined;
    for (const [name, value] of headers) {
      if (value.includes(KEY_SENTINEL)) keyHeader = name;
    }
    if (keyHeader === undefined) return base(input, init);
    const template = headers.get(keyHeader) ?? "";
    const url = requestUrl(input);
    const target: Target = { kind: "origin", value: new URL(url).origin };
    const secret = profile === undefined ? undefined : await keys.resolve(profile, target, init?.signal ?? undefined);
    if (secret === undefined) {
      headers.delete(keyHeader);
      return base(input, { ...init, headers });
    }
    const name = keyHeader;
    return secret.use((value) => {
      headers.set(name, template.replace(KEY_SENTINEL, value));
      return base(input, { ...init, headers });
    });
  };
  return wrapped as typeof fetch;
}
