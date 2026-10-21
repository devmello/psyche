import {
  describeError,
  type MacHelperStatus,
  type ModelChoice,
  type OnboardingResult,
  type SetupCheck,
  t,
} from "@psyche/ui";
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
    await call("vault.unlock", { reason: t("web.setup.vaultReason") }, ik("vault-unlock"));
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
): Promise<{ keyRef: string; recoveryKey?: string; refused?: string }> {
  const call = caller(platform);
  const vault = await ensureVault(call);
  await call("models.setKey", { providerId: provider, key }, ik(`key-${provider}`));
  // Check the key at once (#504): a refused key is reported here, in the field, rather than as a
  // chat that never answers. Only a refusal counts; an unreachable endpoint or an older Gateway
  // without models.probe does not stop the step.
  let refused: string | undefined;
  try {
    const res = (await call("models.probe", { providerId: provider })) as {
      provider?: { probe?: { state?: string; error?: string } };
    };
    const probe = res.provider?.probe;
    if (probe?.state === "auth_failed") refused = probe.error ?? "the key was refused";
  } catch {
    // Not checked; the probe in Settings can run later.
  }
  return { keyRef: `model-${provider}`, ...vault, ...(refused === undefined ? {} : { refused }) };
}

/** The six-case tool check (B4) on the chosen model. */
export async function checkModel(
  platform: ShellPlatform,
  choice: Omit<ModelChoice, "toolCheck">,
): Promise<"passed" | "failed"> {
  const call = caller(platform);
  // A subscription runs through its CLI, whose endpoint is never probed on a fresh install
  // (no key step): probe it first so the Gateway knows it answers (#547).
  const cli = cliProviderOf(choice.modelRef);
  if (cli !== null) await probeProvider(call, cli);
  const res = (await call("models.check", { ref: choice.modelRef })) as {
    result: { status: string };
  };
  return res.result.status === "chat-only" ? "failed" : "passed";
}

interface ModelsList {
  providers: {
    id: string;
    keyConfigured: boolean;
    local: boolean;
    probe?: { state?: string; error?: string };
  }[];
  roles: { primary?: string };
}

/**
 * Subscription providers that run through the vendor's CLI signed in on this Mac. They have no
 * API key; a reachable endpoint probe means the CLI answered (and is logged in), so they count
 * as keyed (#537).
 */
const CLI_PROVIDERS: ReadonlySet<string> = new Set(["claude-code", "codex"]);

/** Display names for the CLI providers, used in Done-step messages. */
const CLI_LABEL: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** The CLI provider id a model ref runs on (`claude-code/sonnet` → `claude-code`), or null. */
export function cliProviderOf(ref: string): string | null {
  const id = ref.trim().split("/", 1)[0] ?? "";
  return CLI_PROVIDERS.has(id) ? id : null;
}

type Probe = { state?: string; error?: string };

/** Runs `models.probe` for a provider; null when the Gateway could not run it. */
async function probeProvider(call: Call, providerId: string): Promise<Probe | null> {
  try {
    const res = (await call("models.probe", { providerId })) as { provider?: { probe?: Probe } };
    return res.provider?.probe ?? null;
  } catch {
    return null;
  }
}

/** The provider can authenticate: local, a stored key, or a signed-in CLI subscription. */
export function providerReady(provider: ModelsList["providers"][number] | undefined): boolean {
  if (provider === undefined) return false;
  if (provider.local || provider.keyConfigured) return true;
  return CLI_PROVIDERS.has(provider.id) && provider.probe?.state === "reachable";
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
      ? {
          id: "gateway",
          label: t("web.setup.gateway"),
          state: "ok",
          detail: t("web.setup.gatewayOk"),
        }
      : {
          id: "gateway",
          label: t("web.setup.gateway"),
          state: "warn",
          detail: t("web.setup.gatewayWarn"),
        },
  );
  // Desktop: the first-admin bootstrap (main process) makes this Mac the admin device.
  if (platform.gateway.deviceId !== undefined && status.phase === "paired") {
    checks.push(
      status.scopes?.includes("operator.admin")
        ? { id: "admin", label: t("web.setup.admin"), state: "ok", detail: t("web.setup.adminOk") }
        : {
            id: "admin",
            label: t("web.setup.admin"),
            state: "warn",
            detail: t("web.setup.adminWarn"),
          },
    );
  }
  if (helper !== undefined && helper.kind !== "unbundled") {
    checks.push(
      helper.kind === "paired"
        ? {
            id: "helper",
            label: t("web.setup.helper"),
            state: "ok",
            detail: t("web.setup.helperOk"),
          }
        : {
            id: "helper",
            label: t("web.setup.helper"),
            state: "warn",
            detail: t("web.setup.helperWarn"),
          },
    );
  }
  const ref = result.model.modelRef.trim();
  let modelCheck: SetupCheck = {
    id: "model",
    label: t("web.setup.model"),
    state: "warn",
    detail: t("web.setup.modelNone"),
  };
  if (ref !== "" && status.phase === "paired") {
    try {
      const override = result.model.toolCheck === "failed";
      const before = (await call("models.list", {})) as ModelsList;
      await call("models.setRole", { role: "primary", ref, override }, ik("role-primary"));
      if (before.roles.primary === undefined || before.roles.primary === ref) {
        await call("models.setRole", { role: "utility", ref, override: true }, ik("role-utility"));
      }
      let after = (await call("models.list", {})) as ModelsList;
      let provider = after.providers.find((p) => ref.startsWith(`${p.id}/`));
      // A subscription CLI is ready only once its endpoint probe is reachable; on a fresh install
      // nothing has probed it yet, so probe now and read the list again (#547).
      const cli = cliProviderOf(ref);
      let cliProbe: Probe | null = null;
      if (cli !== null && provider?.probe?.state !== "reachable") {
        cliProbe = await probeProvider(call, cli);
        after = (await call("models.list", {})) as ModelsList;
        provider = after.providers.find((p) => ref.startsWith(`${p.id}/`));
      }
      const keyed = providerReady(provider);
      const bound = after.roles.primary === ref;
      const notReady = (): string => {
        if (cli === null) return t("web.setup.modelNoKey", { ref });
        const error = provider?.probe?.error ?? cliProbe?.error;
        const cliName = CLI_LABEL[cli] ?? cli;
        return error
          ? t("web.setup.modelCliUnreachable", { ref, cli: cliName, error })
          : t("web.setup.modelCliNotChecked", { ref, cli: cliName });
      };
      modelCheck =
        bound && keyed
          ? {
              id: "model",
              label: t("web.setup.model"),
              state: "ok",
              detail:
                cli === null
                  ? t("web.setup.modelOk", { ref })
                  : t("web.setup.modelOkCli", { ref, cli: CLI_LABEL[cli] ?? cli }),
            }
          : {
              id: "model",
              label: t("web.setup.model"),
              state: "warn",
              detail: keyed ? t("web.setup.modelUnbound", { ref }) : notReady(),
            };
    } catch (err) {
      modelCheck = {
        id: "model",
        label: t("web.setup.model"),
        state: "warn",
        detail: t("web.setup.modelError", { ref, error: describeError(err) }),
      };
    }
  }
  checks.push(modelCheck);
  return checks;
}
