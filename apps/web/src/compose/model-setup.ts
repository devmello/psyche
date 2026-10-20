import type { MacHelperStatus, ModelChoice, OnboardingResult, SetupCheck } from "@psyche/ui";
import type { ShellPlatform } from "../shell/platform.ts";

/**
 * Onboarding's Model & provider step against the Gateway (first run from scratch: no `.env`, an
 * empty `PSYCHE_HOME`). The key goes to the vault through `models.setKey`, which creates nothing
 * itself: when the vault does not exist yet this creates it first with the Gateway's own key
 * slot and hands back the recovery key, shown once. The model is bound when the Done step opens.
 */

type Call = (method: string, params: unknown, idempotencyKey?: string) => Promise<unknown>;

const SLOTS = ["key_file", "keychain", "safe_storage"] as const;

let seq = 0;
const ik = (what: string) => `onboarding:${what}:${Date.now()}:${++seq}`;

function caller(platform: ShellPlatform): Call {
  return (method, params, key) =>
    platform.gateway.call(method, params, key === undefined ? {} : { idempotencyKey: key });
}

const codeOf = (err: unknown) => (err as { code?: string } | null)?.code;

/** Creates the vault when there is none (trying the Gateway's slot) and unlocks it. */
export async function ensureVault(call: Call): Promise<{ recoveryKey?: string }> {
  const { status } = (await call("vault.status", {})) as { status: { state: string } };
  if (status.state === "unlocked") return {};
  if (status.state === "locked") {
    await call("vault.unlock", { reason: "Store your model provider key" }, ik("vault-unlock"));
    return {};
  }
  // The Gateway has exactly one slot; another answers invalid_params without side effects.
  for (const slot of SLOTS) {
    try {
      const res = (await call("vault.setup", { slot }, ik(`vault-setup-${slot}`))) as {
        recoveryKey: string;
      };
      return { recoveryKey: res.recoveryKey };
    } catch (err) {
      if (codeOf(err) !== "invalid_params") throw err;
    }
  }
  throw new Error("the Gateway offers no vault key slot");
}

export async function saveProviderKey(
  platform: ShellPlatform,
  provider: string,
  key: string,
): Promise<{ keyRef: string; recoveryKey?: string }> {
  const call = caller(platform);
  const vault = await ensureVault(call);
  await call("models.setKey", { providerId: provider, key }, ik(`key-${provider}`));
  return { keyRef: `model-${provider}`, ...vault };
}

/** The six-case tool check (B4) on the chosen model. */
export async function checkModel(
  platform: ShellPlatform,
  choice: Omit<ModelChoice, "toolCheck">,
): Promise<"passed" | "failed"> {
  const res = (await caller(platform)("models.check", { ref: choice.modelRef })) as {
    result: { status: string };
  };
  return res.result.status === "chat-only" ? "failed" : "passed";
}

interface ModelsList {
  providers: { id: string; keyConfigured: boolean; local: boolean }[];
  roles: { primary?: string };
}

/**
 * The Done step: bind the chosen model (primary, and utility while none is set), then confirm
 * the Gateway answers, the helper is paired (desktop only) and the model is set with a key.
 */
export async function verifySetup(
  platform: ShellPlatform,
  result: OnboardingResult,
  helper: MacHelperStatus | undefined,
): Promise<SetupCheck[]> {
  const call = caller(platform);
  const checks: SetupCheck[] = [];
  const status = await platform.gateway.getStatus();
  checks.push(
    status.phase === "paired"
      ? { id: "gateway", label: "Gateway", state: "ok", detail: "Running on this Mac." }
      : {
          id: "gateway",
          label: "Gateway",
          state: "warn",
          detail: "Not reachable right now; this window reconnects on its own.",
        },
  );
  if (helper !== undefined && helper.kind !== "unbundled") {
    checks.push(
      helper.kind === "paired"
        ? { id: "helper", label: "Psyche Helper", state: "ok", detail: "Connected." }
        : {
            id: "helper",
            label: "Psyche Helper",
            state: "warn",
            detail: "Not connected yet. Computer use and notifications wait for it.",
          },
    );
  }
  const ref = result.model.modelRef.trim();
  let modelCheck: SetupCheck = {
    id: "model",
    label: "Model",
    state: "warn",
    detail: "None picked. Add one in Settings → Model & providers.",
  };
  if (ref !== "" && status.phase === "paired") {
    try {
      const override = result.model.toolCheck === "failed";
      const before = (await call("models.list", {})) as ModelsList;
      await call("models.setRole", { role: "primary", ref, override }, ik("role-primary"));
      if (before.roles.primary === undefined || before.roles.primary === ref) {
        await call("models.setRole", { role: "utility", ref, override: true }, ik("role-utility"));
      }
      const after = (await call("models.list", {})) as ModelsList;
      const provider = after.providers.find((p) => ref.startsWith(`${p.id}/`));
      const keyed = provider?.local === true || provider?.keyConfigured === true;
      modelCheck =
        after.roles.primary === ref && keyed
          ? { id: "model", label: "Model", state: "ok", detail: `${ref}, key in the vault.` }
          : {
              id: "model",
              label: "Model",
              state: "warn",
              detail: keyed
                ? `${ref} is not bound yet.`
                : `${ref} is set but its provider has no key yet.`,
            };
    } catch (err) {
      modelCheck = {
        id: "model",
        label: "Model",
        state: "warn",
        detail: `Could not set ${ref} (${(err as Error).message}).`,
      };
    }
  }
  checks.push(modelCheck);
  return checks;
}
