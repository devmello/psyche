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
}

/**
 * Environment for ONE sandbox command (security §4.6): `PSYCHE_SECRET_<NAME>` values, nothing
 * inherited. Pass `env` straight to the runner's spawn and call `dispose()` after spawn; never
 * merge it into `process.env`, the image or `config.json`. Mask captured output with the
 * broker's `redact` (values are tracked for the process lifetime).
 */
export interface SecretEnv {
  readonly env: Record<string, string>;
  readonly names: string[];
  dispose(): void;
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export async function buildSecretEnv(input: SecretEnvInput): Promise<SecretEnv> {
  const env: Record<string, string> = {};
  const names: string[] = [];
  const dispose = () => {
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
  return { env, names, dispose };
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
