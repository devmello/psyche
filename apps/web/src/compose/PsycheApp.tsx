import {
  AgentHeader,
  AgentSheet,
  AgentSheetPanel,
  type AgentTab,
  AppearanceProvider,
  agentSheetHref,
  agentSheetRoute,
  ChatThread,
  CommandPalette,
  ConnectedSidebar,
  compactThread,
  compactWithToast,
  describeError,
  destinationFor,
  FeedScreen,
  GatewayProvider,
  GoalsScreen,
  IdeasScreen,
  InboxScreen,
  LIBRARY_SECTIONS,
  LibraryScreen,
  type LibrarySection,
  OnboardingFlow,
  type OnboardingResult,
  type RailItem,
  SearchScreen,
  ThreadContextDialog,
  ThreadContextMeter,
  ThreadList,
  Toaster,
  t,
  type UiSlots,
  UiSlotsProvider,
  useStore,
  useThread,
  useThreadExport,
} from "@psyche/ui";
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useShellComposerVoice } from "../shell/components/composer-voice.ts";
import { ConnectedStartupSplash } from "../shell/components/StartupSplash.tsx";
import { TitleBar } from "../shell/components/TitleBar.tsx";
import { useShellVoiceTerminal } from "../shell/components/voice-terminal.ts";
import type { ShellPlatform, SystemAppearance } from "../shell/platform.ts";
import { type ChatSlotContext, ShellApp, type ShellSlots } from "../shell/ShellApp.tsx";
import { chatFileSlots } from "./attachments.tsx";
import { useMacHelper } from "./helper.tsx";
import { kitClient } from "./kit-client.ts";
import { checkModel, saveProviderKey, verifySetup } from "./model-setup.ts";
import { writeOnboarding } from "./onboarding.ts";
import { readPermissions, requestPermission } from "./permissions.tsx";
import { settingsRoute } from "./settings.tsx";
import { useTranscriptMode } from "./transcript-mode.tsx";
import { ComposedFilesPane, renderMarkdownEditor } from "./viewers.tsx";

/**
 * The composed Psyche app (INT-1): S11's shell (rail, threads, panes, browser, keyboard, `view.*`)
 * with the UI kit's screens in it (docs/06): onboarding on first run, the chat column with
 * message blocks, approval dock and question cards, and the agent sheet (Activity, Approvals,
 * Upcoming, Soul & Memory) behind the avatar and at `/agent/*`, and Settings at `/settings/*`.
 * One Gateway connection serves both.
 */

/** Cosmetic key (no admin needed) recording that onboarding finished on this Gateway. */
export const ONBOARDED_KEY = "ui.onboarding.completedAt";

function KitChat({ threadId, ctx }: { threadId: string; ctx: ChatSlotContext }): ReactElement {
  // The agent sheet (`/agent/*`) is the shell's (`RoutedAgentSheet`): beside this chat on wide
  // windows, over it on narrow ones (#625); the avatar and task rows open it by route.
  const incognito = useThread(threadId).thread?.thread.kind === "incognito";
  const [limitsOpen, setLimitsOpen] = useState(false);
  const store = useStore();
  const [level, setLevel] = useTranscriptMode();
  const exportThread = useThreadExport(threadId);
  // File blocks open in the Files pane (P4); a ref keeps the slots stable across renders.
  const openPane = useRef(ctx.openPane);
  openPane.current = ctx.openPane;
  const voiceTerminal = useShellVoiceTerminal();
  const fileSlots = useMemo(
    () => ({
      ...chatFileSlots((pane, target) => openPane.current(pane, target)),
      // Composer dictation and voice mode (#690): the shell's capture, drawn by the kit.
      useComposerVoice: useShellComposerVoice,
      // Voice conversation (voice-mode-2026 §6.1): the renderer is the audio terminal.
      voiceTerminal,
    }),
    [voiceTerminal],
  );
  return (
    <UiSlotsProvider value={fileSlots}>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="kit-chat"
        data-incognito={incognito ? "true" : undefined}
      >
        <AgentHeader
          onOpenSheet={() => ctx.navigate("/agent/activity")}
          onOpenTask={(taskId) => ctx.navigate(`/agent/activity/${encodeURIComponent(taskId)}`)}
          incognito={incognito}
          onOpenInbox={() => ctx.navigate("/inbox")}
          {...(ctx.thread
            ? { mode: ctx.thread.permissionMode, onModeChange: ctx.setPermissionMode }
            : {})}
          {...(ctx.thread?.modelRef
            ? { model: ctx.thread.modelRef, onOpenModelPicker: ctx.openModelPicker }
            : {})}
          context={
            <ThreadContextMeter threadId={threadId} onEditLimits={() => setLimitsOpen(true)} />
          }
          onContextLimits={() => setLimitsOpen(true)}
          onCompact={() => void compactWithToast(() => compactThread(store, threadId))}
          disclosure={level}
          onDisclosureChange={setLevel}
          onExport={(format) => void exportThread(format)}
        />
        <ThreadContextDialog threadId={threadId} open={limitsOpen} onOpenChange={setLimitsOpen} />
        <ChatThread threadId={threadId} disclosure={level} onDisclosureChange={setLevel} />
      </div>
    </UiSlotsProvider>
  );
}

/**
 * The agent sheet for `/agent/<tab>[/<task>][?file=][&from=]` (redesign §5.7) over the section
 * underneath, which stays mounted (#614): the avatar, the Feed's Schedule, Settings' tasks, and
 * Library's and Ideas' "Open in editor". On wide windows it sits beside the content as the inline
 * panel and the shell slides its column in (#625); on narrow ones it is the modal sheet, which
 * keeps its last route while it animates out. Tabs change the route; closing (×, Escape, the
 * backdrop) returns to the section, or to `?from=` when the sheet was opened cold (#614).
 */
function RoutedAgentSheet({
  route,
  presentation,
  navigate,
  onClose,
}: {
  route: string | null;
  presentation: "inline" | "overlay";
  navigate: (to: string) => void;
  onClose: () => void;
}): ReactElement | null {
  const routed = route === null ? null : agentSheetRoute(route);
  const lastRouted = useRef(routed);
  if (routed !== null) lastRouted.current = routed;
  const sheet = routed ?? lastRouted.current;
  if (sheet === null) return null;
  const close = () => (sheet.back ? navigate(sheet.back) : onClose());
  const body = {
    tab: sheet.tab,
    onTabChange: (tab: AgentTab) =>
      navigate(agentSheetHref(tab, sheet.back ? { back: sheet.back } : {})),
    ...(sheet.taskId === undefined ? {} : { taskId: sheet.taskId }),
    ...(sheet.runId === undefined ? {} : { runId: sheet.runId }),
    ...(sheet.stepId === undefined ? {} : { stepId: sheet.stepId }),
    ...(sheet.file === undefined ? {} : { file: sheet.file }),
    ...(sheet.entity === undefined ? {} : { entity: sheet.entity }),
    onClose: close,
  };
  return presentation === "inline" ? (
    <AgentSheetPanel {...body} />
  ) : (
    <AgentSheet
      open={routed !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      {...body}
    />
  );
}

/** The destination a route belongs to (the agent sheet routes belong to Chat). */
export function railItemFor(route: string): RailItem | null {
  return destinationFor(route);
}

/**
 * The rail screens (docs/06 §2.7 routes): Search, Feed, Ideas, Goals, Library and the
 * notification inbox, each the UI kit's connected screen in a scrolling page.
 */
export function screenRoute(route: string, navigate: (to: string) => void): ReactNode | null {
  const [path = "", query = ""] = route.split("?");
  const parts = path.split("/").filter(Boolean);
  const page = (label: string, child: ReactNode) => (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      aria-label={label}
      data-testid={`screen-${parts[0]}`}
    >
      {child}
    </section>
  );
  switch (parts[0]) {
    case "search": {
      const q = new URLSearchParams(query).get("q") ?? "";
      return page(
        "Search",
        <SearchScreen
          initialQuery={q}
          autoFocus
          onOpen={(hit) => {
            if (hit.threadId) navigate(`/chat/${hit.threadId}`);
          }}
        />,
      );
    }
    case "feed":
      // `/feed/instructions` is the feed with its instructions sheet open (#614).
      return page(
        "Feed",
        <FeedScreen
          instructionsOpen={parts[1] === "instructions"}
          onCloseInstructions={() => navigate("/feed")}
        />,
      );
    case "ideas":
      return page("Ideas", <IdeasScreen />);
    case "goals":
      return page(
        "Goals",
        <GoalsScreen
          selectedGoalId={parts[1] ?? null}
          onOpenGoal={(goal) => navigate(`/goals/${goal.id}`)}
        />,
      );
    case "library": {
      const section = (LIBRARY_SECTIONS.find((s) => s.id === parts[1])?.id ??
        "documents") as LibrarySection;
      return page(
        "Library",
        <LibraryScreen
          section={section}
          onSectionChange={(next) => navigate(`/library/${next}`)}
        />,
      );
    }
    case "inbox":
      return page(
        "Inbox",
        <InboxScreen
          onOpen={(n) => {
            if (n.route) navigate(n.route);
          }}
        />,
      );
    default:
      return null;
  }
}

/** Turns the onboarding answers into workspace writes and remembers that onboarding is done. */
export async function completeOnboarding(
  platform: ShellPlatform,
  result: OnboardingResult,
  now: () => Date = () => new Date(),
): Promise<void> {
  const call = (m: string, p: unknown, o?: { idempotencyKey?: string }) =>
    platform.gateway.call(m, p, o ?? {});
  await writeOnboarding(call, {
    name: result.persona.name,
    creature: result.persona.creatureDescription || result.persona.creatureId,
    tagline: result.persona.tagline,
  });
  await call(
    "settings.set",
    { key: ONBOARDED_KEY, value: now().toISOString() },
    { idempotencyKey: `onboarding:done:${now().getTime()}` },
  );
  await greetMainChat(call, now);
}

/**
 * The Done step promises "{name}'s first message" (#555): ask the Gateway to start the agent's
 * greeting in the main chat. The Gateway does nothing when the chat already has messages, and a
 * failure here (an older Gateway, a model error) never blocks finishing onboarding.
 */
export async function greetMainChat(
  call: (m: string, p: unknown, o?: { idempotencyKey?: string }) => Promise<unknown>,
  now: () => Date = () => new Date(),
): Promise<void> {
  try {
    const list = (await call("threads.list", { kind: "main" })) as {
      threads: { thread: { id: string } }[];
    };
    const main = list.threads[0]?.thread.id;
    if (main === undefined) return;
    await call(
      "chat.greet",
      { threadId: main },
      { idempotencyKey: `onboarding:greet:${main}:${now().getTime()}` },
    );
  } catch {
    // The chat still opens; the owner can say hello first.
  }
}

type Gate = "loading" | "onboarding" | "ready";
type Persona = NonNullable<UiSlots["persona"]>;

/** `name` / `creature` from IDENTITY.md's frontmatter (quoted or bare YAML scalars). */
export function personaFromIdentity(content: string): Persona | null {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (fm === undefined) return null;
  const field = (key: string): string | undefined => {
    const raw = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim();
    if (raw === undefined || raw === "") return undefined;
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw) as string;
      } catch {
        return raw.slice(1, -1);
      }
    }
    return raw.replace(/^'(.*)'$/, "$1");
  };
  const name = field("name");
  if (!name) return null;
  const creature = field("creature");
  return creature ? { name, creature } : { name };
}

/** The agent's name and creature for the kit's cards, kept in step with IDENTITY.md. */
function useWorkspacePersona(platform: ShellPlatform): [Persona | null, () => void] {
  const [persona, setPersona] = useState<Persona | null>(null);
  const load = useMemo(
    () => () => {
      void (
        platform.gateway.call("memory.read", { path: "IDENTITY.md" }) as Promise<{
          content: string;
        }>
      )
        .then((r) => setPersona(personaFromIdentity(r.content)))
        .catch(() => undefined);
    },
    [platform],
  );
  useEffect(() => {
    void platform.gateway.getStatus().then(
      (s) => s.phase === "paired" && load(),
      () => undefined,
    );
    // Status arrives on every health check; read IDENTITY.md again only when pairing begins.
    let paired = false;
    const offStatus = platform.gateway.onStatus((s) => {
      if (s.phase === "paired" && !paired) load();
      paired = s.phase === "paired";
    });
    const offEvent = platform.gateway.onEvent((e) => {
      if (
        e.event === "memory.file.changed" &&
        (e.payload as { path?: string }).path === "IDENTITY.md"
      ) {
        load();
      }
    });
    return () => {
      offStatus();
      offEvent();
    };
  }, [platform, load]);
  return [persona, load];
}

/**
 * The owner's region format for numbers, dates and times (A12): macOS's on the desktop, the
 * browser's language on the web. Settings → Appearance → Language and region can override it.
 */
function useSystemLocale(platform: ShellPlatform): string | null {
  const [locale, setLocale] = useState<string | null>(() => globalThis.navigator?.language ?? null);
  useEffect(() => {
    let live = true;
    void platform.locale?.get().then(
      (l) => live && setLocale(l.system),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [platform]);
  return locale;
}

/** macOS Reduce Transparency / Increase Contrast from the desktop main (redesign §3.4, §8). */
function useSystemAppearance(platform: ShellPlatform): SystemAppearance | null {
  const [appearance, setAppearance] = useState<SystemAppearance | null>(null);
  useEffect(() => {
    const port = platform.systemAppearance;
    if (!port) return;
    let live = true;
    void port.get().then(
      (a) => live && setAppearance(a),
      () => undefined,
    );
    const off = port.on((a) => setAppearance(a));
    return () => {
      live = false;
      off();
    };
  }, [platform]);
  return appearance;
}

export function PsycheApp({ platform }: { platform: ShellPlatform }): ReactElement {
  const client = useMemo(() => kitClient(platform.gateway, platform.passkeys), [platform]);
  const systemLocale = useSystemLocale(platform);
  const systemAppearance = useSystemAppearance(platform);
  const [gate, setGate] = useState<Gate>("loading");
  const [error, setError] = useState<string | null>(null);
  const [persona, reloadPersona] = useWorkspacePersona(platform);
  const helper = useMacHelper(platform);
  const helperRef = useRef(helper);
  helperRef.current = helper;
  const verify = useMemo(
    () => (result: OnboardingResult) => verifySetup(platform, result, helperRef.current),
    [platform],
  );

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const status = await platform.gateway.getStatus();
      if (status.phase !== "paired") return;
      const res = (await platform.gateway.call("settings.get", { keys: [ONBOARDED_KEY] })) as {
        settings: Record<string, unknown>;
      };
      if (!cancelled) setGate(res.settings[ONBOARDED_KEY] ? "ready" : "onboarding");
    };
    const retry = () => void check().catch(() => undefined);
    retry();
    let paired = false;
    const off = platform.gateway.onStatus((s) => {
      if (s.phase === "paired" && !paired) retry();
      paired = s.phase === "paired";
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [platform]);

  const slots = useMemo<ShellSlots>(
    () => ({
      chat: (threadId, ctx) => <KitChat threadId={threadId} ctx={ctx} />,
      section: (route, navigate) =>
        settingsRoute(route, navigate, platform) ?? screenRoute(route, navigate),
      agentSheet: (p) => <RoutedAgentSheet {...p} />,
      // The 2026 sidebar (redesign §5.1); the compact drawer shows its threads alone (§5.11).
      sidebar: (p) => (
        <ConnectedSidebar
          route={p.route}
          onNavigate={p.navigate}
          activeThreadId={p.threadId}
          onOpenThread={p.onOpenThread}
          onNewSideChat={p.onNew}
          width={p.width}
          onWidthChange={p.onWidthChange}
          mode={p.mode}
          onModeChange={p.onModeChange}
          {...(p.header ? { header: p.header } : {})}
        />
      ),
      threadList: ({ threadId, onOpen, onNew }) => (
        <ThreadList activeThreadId={threadId} onOpen={onOpen} onNewSideChat={onNew} />
      ),
      // One search surface for ⌘K and the Search destination (§5.5).
      palette: ({ open, onClose, navigate, actions }) => (
        <CommandPalette
          open={open}
          onOpenChange={(o) => {
            if (!o) onClose();
          }}
          onNavigate={navigate}
          actions={actions}
        />
      ),
      // The Files pane renders the viewers (§3.7, P4); other panes keep the shell's views.
      pane: (pane, ctx) =>
        pane.pane === "files" ? (
          <ComposedFilesPane target={pane.target} navigate={ctx.navigate} />
        ) : null,
    }),
    [platform],
  );

  let body: ReactNode;
  if (gate === "onboarding") {
    body = (
      <div className="flex h-dvh flex-col" data-testid="onboarding">
        <TitleBar chrome={platform.chrome}>
          <span className="title">{t("web.onboarding.title")}</span>
        </TitleBar>
        <main
          className="flex min-h-0 flex-1 flex-col overflow-auto"
          data-testid="onboarding-scroll"
        >
          {error ? (
            <p
              role="alert"
              className="mx-auto mt-4 w-full max-w-4xl px-6 text-danger-text sm:px-10"
            >
              {error}
            </p>
          ) : null}
          <OnboardingFlow
            {...(helper ? { helper } : {})}
            // Only the desktop can ask macOS; the web skips the step (#554).
            macPermissions={platform.permissions !== undefined}
            onRequestPermission={(p) => requestPermission(platform, p)}
            onReadPermissions={() => readPermissions(platform)}
            onSaveKey={(provider, key) => saveProviderKey(platform, provider, key)}
            onCheckModel={(choice) => checkModel(platform, choice)}
            onVerify={verify}
            onComplete={(result) => {
              completeOnboarding(platform, result).then(
                () => {
                  reloadPersona();
                  setGate("ready");
                },
                (err: unknown) =>
                  setError(t("web.onboarding.saveError", { error: describeError(err) })),
              );
            }}
          />
        </main>
      </div>
    );
  } else {
    // While the Gateway is unreachable the shell shows its offline banner; it is the same app.
    body = <ShellApp platform={platform} slots={slots} />;
  }
  const uiSlots = useMemo<UiSlots>(
    () => ({
      ...(persona ? { persona } : {}),
      // Soul & Memory's file editor: the viewers' Markdown editor (Rich / Source / Diff).
      renderEditor: renderMarkdownEditor,
      // The desktop session refuses navigator.clipboard; copy goes through main (#507).
      ...(platform.clipboard ? { writeClipboard: platform.clipboard.writeText } : {}),
      // Connector sign-ins open in the default browser; app windows refuse window.open (#505).
      ...(platform.external ? { openExternal: platform.external.open } : {}),
    }),
    [persona, platform],
  );
  return (
    <GatewayProvider client={client}>
      {/* Appearance (theme, contrast, reduce motion) and the kit's toasts (docs/a11y-audit.md A1, A2). */}
      <AppearanceProvider systemLocale={systemLocale} system={systemAppearance}>
        <UiSlotsProvider value={uiSlots}>
          {body}
          <Toaster />
          {/* The startup splash is the main window's first content (#539). */}
          <ConnectedStartupSplash platform={platform} />
        </UiSlotsProvider>
      </AppearanceProvider>
    </GatewayProvider>
  );
}
