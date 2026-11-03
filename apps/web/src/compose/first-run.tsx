import { type OnboardingProgress, type OnboardingResult, t, useSlots } from "@psyche/ui";
import {
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ShellPlatform } from "../shell/platform.ts";
import { useMacHelper } from "./helper.tsx";
import { checkModel, saveProviderKey, verifySetup } from "./model-setup.ts";
import {
  type CurrentSetup,
  commitImport,
  createStarterAutomation,
  detectCompleted,
  loadCurrent,
  loadProgress,
  previewImport,
  saveProgress,
  touchIdSetup,
} from "./onboarding-host.ts";
import { readPermissions, requestPermission } from "./permissions.tsx";

// Loaded on demand: first-run code is not part of the main bundle path.
const OnboardingFlow = lazy(() =>
  import("@psyche/ui/onboarding").then((m) => ({ default: m.OnboardingFlow })),
);
const CapabilitiesScreen = lazy(() =>
  import("@psyche/ui/capabilities").then((m) => ({ default: m.CapabilitiesScreen })),
);

const call =
  (platform: ShellPlatform) => (m: string, p: unknown, o?: { idempotencyKey?: string }) =>
    platform.gateway.call(m, p, o ?? {});

/**
 * The first-run flow with the Gateway wired in. `first`: resumes from saved progress. `rerun`
 * (Settings → About → Run setup again, docs/design/onboarding-2026.md §5): every step is shown
 * pre-filled from what is stored; only a model that is already set and ready is left out.
 */
export function FirstRun({
  platform,
  mode,
  onComplete,
}: {
  platform: ShellPlatform;
  mode: "first" | "rerun";
  onComplete: (result: OnboardingResult) => void;
}): ReactElement | null {
  const helper = useMacHelper(platform);
  const gw = useMemo(() => call(platform), [platform]);
  const [start, setStart] = useState<{
    progress: OnboardingProgress | null;
    completed: OnboardingProgress["done"];
    current: CurrentSetup | null;
  } | null>(null);
  const touchId = useMemo(() => touchIdSetup(gw, platform.helper?.touchId), [gw, platform]);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (mode === "first")
        return { progress: await loadProgress(gw).catch(() => null), completed: [], current: null };
      // The agent's persona is edited in Settings; a re-run never rewrites it (`rerun` hides it).
      const [completed, current] = await Promise.all([detectCompleted(gw), loadCurrent(gw)]);
      return { progress: null, completed, current };
    };
    void load().then((s) => live && setStart(s));
    return () => {
      live = false;
    };
  }, [gw, mode]);

  if (start === null) return null;
  const resumeStep = start.progress?.step;
  return (
    <Suspense fallback={null}>
      <OnboardingFlow
        {...(resumeStep ? { defaultStep: resumeStep } : {})}
        completed={start.completed}
        rerun={mode === "rerun"}
        {...(start.current
          ? {
              initial: {
                owner: start.current.owner,
                ...(start.current.habits ? { habits: start.current.habits } : {}),
                ...(start.current.mail ? { mail: start.current.mail } : {}),
                memory: start.current.memory,
              },
            }
          : {})}
        {...(touchId ? { touchId } : {})}
        {...(helper ? { helper } : {})}
        macPermissions={platform.permissions !== undefined}
        onRequestPermission={(p) => requestPermission(platform, p)}
        onReadPermissions={() => readPermissions(platform)}
        onSaveKey={(provider, key) => saveProviderKey(platform, provider, key)}
        onCheckModel={(choice) => checkModel(platform, choice)}
        onVerify={(result) => verifySetup(platform, result, helper)}
        onPreviewImport={(format, content) => previewImport(gw, format, content)}
        onCommitImport={(items) => commitImport(gw, items)}
        onProgress={(p) => void saveProgress(gw, p).catch(() => undefined)}
        onComplete={onComplete}
      />
    </Suspense>
  );
}

/** `/can-do` ("What can you do?") and `/onboarding` (re-run); null for any other route. */
export function onboardingRoute(
  route: string,
  navigate: (to: string) => void,
  platform: ShellPlatform,
  complete: (result: OnboardingResult) => Promise<void>,
): ReactNode | null {
  const page = route.split("#")[0]?.split("?")[0]?.split("/").filter(Boolean)[0];
  if (page === "can-do") {
    return (
      <section
        className="flex min-h-0 flex-1 flex-col overflow-auto"
        aria-label={t("capabilities.title")}
        data-testid="screen-can-do"
      >
        <Suspense fallback={null}>
          <CanDo platform={platform} navigate={navigate} />
        </Suspense>
      </section>
    );
  }
  if (page === "onboarding") {
    return (
      <section
        className="flex min-h-0 flex-1 flex-col overflow-auto"
        aria-label={t("onboarding.rerun.title")}
        data-testid="screen-onboarding-rerun"
      >
        <FirstRun
          platform={platform}
          mode="rerun"
          onComplete={(result) => void complete(result).then(() => navigate("/chat"))}
        />
      </section>
    );
  }
  return null;
}

/** The capability cards: an example prompt fills the composer in the main chat. */
function CanDo({
  platform,
  navigate,
}: {
  platform: ShellPlatform;
  navigate: (to: string) => void;
}): ReactElement {
  const { prefillComposer } = useSlots();
  const gw = useMemo(() => call(platform), [platform]);
  return (
    <CapabilitiesScreen
      onUsePrompt={(prompt) => {
        navigate("/chat");
        prefillComposer?.(prompt);
      }}
      onCreateAutomation={(_id, cron, name) => createStarterAutomation(gw, name, cron, `${name}.`)}
      onConnect={() => navigate("/settings/connectors")}
    />
  );
}
