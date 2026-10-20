import type { CredentialBroker, Target } from "@psyche/protocol";
import { fail } from "../errors.ts";

export interface SecretEnvEntry {
  /** Becomes `PSYCHE_SECRET_<NAME>`. */
  name: string;
  placeholder: string;
  /** Each item needs its own approved `credential_fill`. */
  approvalId: string;
}

export interface SecretEnvInput {
  broker: CredentialBroker;
  entries: SecretEnvEntry[];
  /** The network destination the command is approved to use the secret against. */
  target: Target;
  taskId?: string;
  /**
   * The lease (#290): the values live for one command only. When the command's `timeoutMs`
   * (plus `graceMs`, default 5 s) has passed, the env is wiped even if the caller never called
   * `dispose()`. Default: 10 minutes, the longest exec the Gateway allows.
   */
  lease?: { timeoutMs: number; graceMs?: number; now?: () => number };
}

/** Default lease: the Gateway's longest exec (10 min) plus the grace. */
export const SECRET_LEASE_DEFAULT_MS = 10 * 60_000;

/**
 * Environment for ONE sandbox command (security §4.6): `PSYCHE_SECRET_<NAME>` values, nothing
 * inherited. Pass `env` straight to the runner's spawn and call `dispose()` after spawn; never
 * merge it into `process.env`, the image or `config.json`. Mask captured output with the
 * broker's `redact` (values are tracked for the process lifetime).
 */
export interface SecretEnv {
  readonly env: Record<string, string>;
  readonly names: string[];
  /** Epoch ms after which the values are gone whatever the caller does. */
  readonly expiresAt: number;
  /** False once disposed or expired. */
  readonly active: boolean;
  /** Wipe the values now; idempotent. Call it right after spawn, or after the command returns. */
  dispose(): void;
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export async function buildSecretEnv(input: SecretEnvInput): Promise<SecretEnv> {
  const env: Record<string, string> = {};
  const names: string[] = [];
  const now = input.lease?.now ?? Date.now;
  const lifetime =
    (input.lease?.timeoutMs ?? SECRET_LEASE_DEFAULT_MS) + (input.lease?.graceMs ?? 5_000);
  if (!Number.isFinite(lifetime) || lifetime <= 0) {
    return fail("invalid_params", "a secret lease needs a positive timeout");
  }
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
    for (const k of Object.keys(env)) {
      env[k] = "";
      delete env[k];
    }
  };
  try {
    await fillEnv(input, env, names);
  } catch (err) {
    dispose();
    throw err;
  }
  const expiresAt = now() + lifetime;
  // The command cannot outlive its timeout, and neither may the values (#290).
  timer = setTimeout(dispose, lifetime);
  timer.unref?.();
  return {
    env,
    names,
    expiresAt,
    get active() {
      if (active && now() >= expiresAt) dispose();
      return active;
    },
    dispose,
  };
}

async function fillEnv(input: SecretEnvInput, env: Record<string, string>, names: string[]) {
  for (const entry of input.entries) {
    if (!NAME_RE.test(entry.name))
      return fail("invalid_params", "secret env names are A-Z, 0-9, _");
    const key = `PSYCHE_SECRET_${entry.name}`;
    if (key in env) return fail("invalid_params", `duplicate secret env ${entry.name}`);
    const handle = await input.broker.resolve(entry.placeholder, input.target, entry.approvalId, {
      executor: "sandbox",
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    });
    handle.use((value) => {
      env[key] = value;
    });
    names.push(key);
  }
}
