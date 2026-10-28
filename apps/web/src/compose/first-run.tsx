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
  commitImport,
  createStarterAutomation,
  detectCompleted,
  loadProgress,
  previewImport,
  runWin,
  saveProgress,
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
 * (Settings → About → Run setup again): leaves out what is already set up.
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
  } | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      if (mode === "first")
        return { progress: await loadProgress(gw).catch(() => null), completed: [] };
      // The agent's persona is edited in Settings; a re-run never rewrites it.
      const completed = await detectCompleted(gw);
      return { progress: null, completed: [...completed, "agent" as const] };
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
        {...(helper ? { helper } : {})}
        macPermissions={platform.permissions !== undefined}
        onRequestPermission={(p) => requestPermission(platform, p)}
        onReadPermissions={() => readPermissions(platform)}
        onSaveKey={(provider, key) => saveProviderKey(platform, provider, key)}
        onCheckModel={(choice) => checkModel(platform, choice)}
        onVerify={(result) => verifySetup(platform, result, helper)}
        onPreviewImport={(format, content) => previewImport(gw, format, content)}
        onCommitImport={(items) => commitImport(gw, items)}
        onRunWin={(win) => runWin(gw, win)}
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
