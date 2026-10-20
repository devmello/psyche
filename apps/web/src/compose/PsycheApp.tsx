import {
  AgentHeader,
  AgentSheet,
  AgentSheetBody,
  type AgentTab,
  AppearanceProvider,
  ChatThread,
  compactThread,
  compactWithToast,
  describeError,
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
  Rail,
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
} from "@psyche/ui";
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { TitleBar } from "../shell/components/TitleBar.tsx";
import type { ShellPlatform } from "../shell/platform.ts";
import { type ChatSlotContext, ShellApp, type ShellSlots } from "../shell/ShellApp.tsx";
import { chatFileSlots } from "./attachments.tsx";
import { useMacHelper } from "./helper.tsx";
import { kitClient } from "./kit-client.ts";
import { checkModel, saveProviderKey, verifySetup } from "./model-setup.ts";
import { writeOnboarding } from "./onboarding.ts";
import { readPermissions, requestPermission } from "./permissions.tsx";
import { settingsRoute } from "./settings.tsx";
import { TranscriptModeBar, useTranscriptMode } from "./transcript-mode.tsx";
import { ComposedFilesPane } from "./viewers.tsx";

/**
 * The composed Psyche app (INT-1): S11's shell (rail, threads, panes, browser, keyboard, `view.*`)
 * with the UI kit's screens in it (docs/06): onboarding on first run, the chat column with
 * message blocks, approval dock and question cards, and the agent sheet (Activity, Approvals,
 * Upcoming, Soul & Memory) behind the avatar and at `/agent/*`, and Settings at `/settings/*`.
 * One Gateway connection serves both.
 */

/** Cosmetic key (no admin needed) recording that onboarding finished on this Gateway. */
export const ONBOARDED_KEY = "ui.onboarding.completedAt";

const TABS: readonly AgentTab[] = ["activity", "approvals", "upcoming", "soul"];

function KitChat({ threadId, ctx }: { threadId: string; ctx: ChatSlotContext }): ReactElement {
  const [sheet, setSheet] = useState<{ open: boolean; tab: AgentTab; taskId?: string }>({
    open: false,
    tab: "activity",
  });
  const incognito = useThread(threadId).thread?.thread.kind === "incognito";
  const [limitsOpen, setLimitsOpen] = useState(false);
  const store = useStore();
  const [level, setLevel] = useTranscriptMode();
  // File blocks open in the Files pane (P4); a ref keeps the slots stable across renders.
  const openPane = useRef(ctx.openPane);
  openPane.current = ctx.openPane;
  const fileSlots = useMemo(
    () => chatFileSlots((pane, target) => openPane.current(pane, target)),
    [],
  );
  return (
    <UiSlotsProvider value={fileSlots}>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        data-testid="kit-chat"
        data-incognito={incognito ? "true" : undefined}
      >
        <AgentHeader
          onOpenSheet={() => setSheet((s) => ({ ...s, open: true }))}
          onOpenTask={(taskId) => setSheet({ open: true, tab: "activity", taskId })}
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
        />
        <ThreadContextDialog threadId={threadId} open={limitsOpen} onOpenChange={setLimitsOpen} />
        <TranscriptModeBar level={level} onChange={setLevel} incognito={incognito} />
        <ChatThread threadId={threadId} disclosure={level} onDisclosureChange={setLevel} />
        <AgentSheet
          open={sheet.open}
          onOpenChange={(open) => setSheet((s) => ({ ...s, open }))}
          tab={sheet.tab}
          onTabChange={(tab) => setSheet((s) => ({ ...s, tab }))}
          {...(sheet.taskId === undefined ? {} : { taskId: sheet.taskId })}
        />
      </div>
    </UiSlotsProvider>
  );
}

function agentRoute(route: string, navigate: (to: string) => void): ReactNode | null {
  const m = /^\/agent\/(activity|approvals|upcoming|soul)(?:\/([^/?]+))?/.exec(route);
  if (m === null) return null;
  const tab = (TABS.find((x) => x === m[1]) ?? "activity") as AgentTab;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      aria-label={t("web.agent.label")}
    >
      <AgentSheetBody
        tab={tab}
        onTabChange={(next) => navigate(`/agent/${next}`)}
        {...(m[2] === undefined ? {} : { taskId: m[2] })}
      />
    </section>
  );
}

const RAIL_ITEMS: readonly RailItem[] = ["chat", "search", "feed", "ideas", "goals", "library"];

/** The rail item a route belongs to (the agent sheet routes belong to Chat). */
export function railItemFor(route: string): RailItem | null {
  const first = route.split(/[/?]/)[1] ?? "";
  if (first === "agent") return "chat";
  return RAIL_ITEMS.find((r) => r === first) ?? null;
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
      return page("Feed", <FeedScreen />);
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

export function PsycheApp({ platform }: { platform: ShellPlatform }): ReactElement {
  const client = useMemo(() => kitClient(platform.gateway, platform.passkeys), [platform]);
  const systemLocale = useSystemLocale(platform);
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
        settingsRoute(route, navigate, platform) ??
        agentRoute(route, navigate) ??
        screenRoute(route, navigate),
      rail: ({ route, compact, navigate }) => (
        <Rail active={railItemFor(route)} onNavigate={navigate} compact={compact} />
      ),
      threadList: ({ threadId, onOpen, onNew }) => (
        <ThreadList activeThreadId={threadId} onOpen={onOpen} onNewSideChat={onNew} />
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
  const uiSlots = useMemo<UiSlots>(() => (persona ? { persona } : {}), [persona]);
  return (
    <GatewayProvider client={client}>
      {/* Appearance (theme, contrast, reduce motion) and the kit's toasts (docs/a11y-audit.md A1, A2). */}
      <AppearanceProvider systemLocale={systemLocale}>
        <UiSlotsProvider value={uiSlots}>
          {body}
          <Toaster />
        </UiSlotsProvider>
      </AppearanceProvider>
    </GatewayProvider>
  );
}
