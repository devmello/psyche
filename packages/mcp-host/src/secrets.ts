import {
  type CredentialBroker,
  PLACEHOLDER_PATTERN,
  PsycheError,
  parsePlaceholders,
  type Target,
} from "@psyche/protocol";

/**
 * Vault secrets for MCP servers (security §11): a stdio server's env values may contain
 * `{{cred:slug}}` placeholders, resolved by the Credential Broker at spawn and handed only to the
 * child's environment. Placeholders are refused anywhere else in a config (argv is visible in
 * `ps`; a remote `url` is an exfiltration channel), and config files never hold the values.
 */
export interface SecretInjection {
  credentials: CredentialBroker;
  /**
   * Returns the id of an approved `credential_fill` covering `placeholder` for this server
   * (from the Permission Broker). Rejects when the owner declines.
   */
  approve(input: {
    serverId: string;
    placeholder: string;
    envName: string;
    target: Target;
  }): Promise<string>;
}

/** Vault binding target for a server: items bind with `{ connector: "mcp:<serverId>" }`. */
export function mcpCredentialTarget(serverId: string): Target {
  return { kind: "account", value: `mcp:${serverId}`, display: `MCP server ${serverId}` };
}

/**
 * Env names a config may not set (case-insensitive): they would steer the launcher (`srt` is a
 * Node process spawned with this env), its PATH lookups (`node`, `sandbox-exec`, `bwrap`), shell
 * start-up files, TLS trust or proxies, or the dynamic loader before the sandbox applies.
 */
const BLOCKED_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|IFS|PS4|ENV|BASH_ENV|ZDOTDIR|PROMPT_COMMAND|NODE_.*|NPM_CONFIG_.*|COREPACK_.*|SRT_.*|DYLD_.*|LD_.*|ELECTRON_.*|SSL_CERT_.*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|(HTTPS?|ALL|NO|FTP)_PROXY|PYTHONPATH|PYTHONSTARTUP|PERL5LIB|PERL5OPT|RUBYOPT|RUBYLIB|GIT_.*|XDG_CONFIG_HOME)$/i;

export function assertNoPlaceholders(value: string, where: string): void {
  if (new RegExp(PLACEHOLDER_PATTERN.source).test(value) || value.includes("{{cred:")) {
    throw new PsycheError("invalid_params", `credential placeholders are not allowed in ${where}`);
  }
}

export function validateEnv(env: Record<string, string>): void {
  for (const name of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new PsycheError("invalid_params", `invalid env name ${JSON.stringify(name)}`);
    }
    if (BLOCKED_ENV.test(name)) {
      throw new PsycheError("invalid_params", `env ${name} may not be set for an MCP server`);
    }
  }
}

/** Resolve every placeholder in `env`; values without placeholders pass through unchanged. */
export async function resolveEnv(
  serverId: string,
  env: Record<string, string>,
  injection: SecretInjection | undefined,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  validateEnv(env);
  const out: Record<string, string> = {};
  const target = mcpCredentialTarget(serverId);
  for (const [name, value] of Object.entries(env)) {
    const refs = parsePlaceholders(value);
    if (refs.length === 0) {
      if (value.includes("{{cred:")) {
        throw new PsycheError("invalid_params", `malformed credential placeholder in env ${name}`);
      }
      out[name] = value;
      continue;
    }
    if (injection === undefined) {
      throw new PsycheError(
        "unavailable",
        `env ${name} needs a vault secret but no credential broker is configured`,
      );
    }
    let resolved = "";
    let last = 0;
    for (const ref of refs) {
      resolved += value.slice(last, ref.index);
      const approvalId = await injection.approve({
        serverId,
        placeholder: ref.raw,
        envName: name,
        target,
      });
      const secret = await injection.credentials.resolve(ref.raw, target, approvalId, {
        executor: "connector",
        ...(signal === undefined ? {} : { signal }),
      });
      resolved += secret.use((v) => v);
      last = ref.index + ref.raw.length;
    }
    out[name] = resolved + value.slice(last);
  }
  return out;
}
