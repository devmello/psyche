import type { Connector } from "@psyche/protocol";
import {
  Activity,
  Bot,
  Cable,
  FolderLock,
  Globe,
  Info,
  KeyRound,
  type LucideIcon,
  MessagesSquare,
  Mic,
  MonitorCog,
  MonitorSmartphone,
  MousePointerClick,
  Palette,
  Plug,
  Puzzle,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { UsageSummary } from "../../fixtures/index.ts";
import { t } from "../../i18n/core.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { BrowserSection } from "./BrowserSection.tsx";
import { ChannelsSection } from "./ChannelsSection.tsx";
import { ComputerUseSection } from "./ComputerUseSection.tsx";
import { ConnectorsSection, type ScopeMode } from "./ConnectorsSection.tsx";
import { CredentialsSection } from "./CredentialsSection.tsx";
import { DataControlsSection, type ExportFile } from "./DataControlsSection.tsx";
import { DevicesSection } from "./DevicesSection.tsx";
import { FileAccessSection } from "./FileAccessSection.tsx";
import { McpSection } from "./McpSection.tsx";
import { ModelSection } from "./ModelSection.tsx";
import { PermissionsSection } from "./PermissionsSection.tsx";
import { PersonaSection } from "./PersonaSection.tsx";
import { ServerSection } from "./ServerSection.tsx";
import { SettingsApprovalProvider } from "./SettingsApproval.tsx";
import { SkillsSection } from "./SkillsSection.tsx";
import { SETTING_LABELS } from "./setting-labels.ts";
import type {
  AboutInfo,
  DoctorCheck,
  ProviderInfo,
  ServerStatus,
  TccPermission,
  TccState,
} from "./types.ts";
import { UsageSection } from "./UsageSection.tsx";
import { VmSection } from "./VmSection.tsx";
import { VoiceSection } from "./VoiceSection.tsx";

/** Settings (UI design §2.6, §3.18): a section nav and one component per section. */

export type SettingsSectionId =
  | "model"
  | "persona"
  | "connectors"
  | "mcp"
  | "skills"
  | "permissions"
  | "computer-use"
  | "browser"
  | "files"
  | "vm"
  | "devices"
  | "channels"
  | "credentials"
  | "appearance"
  | "voice"
  | "data"
  | "server"
  | "usage"
  | "about";

interface SettingsSectionEntry {
  id: SettingsSectionId;
  /** The nav label, in the active language (`settings.nav.<id>`). */
  readonly label: string;
  icon: LucideIcon;
}

const entry = (id: SettingsSectionId, icon: LucideIcon): SettingsSectionEntry => ({
  id,
  icon,
  get label() {
    // Message ids are camelCase; the route id keeps its hyphen.
    return t(`settings.nav.${id === "computer-use" ? "computerUse" : id}`);
  },
});

export const SETTINGS_SECTIONS: readonly SettingsSectionEntry[] = [
  entry("model", Bot),
  entry("persona", Sparkles),
  entry("connectors", Plug),
  entry("mcp", Cable),
  entry("skills", Puzzle),
  entry("permissions", ShieldCheck),
  entry("computer-use", MousePointerClick),
  entry("browser", Globe),
  entry("files", FolderLock),
  entry("vm", MonitorCog),
  entry("devices", MonitorSmartphone),
  entry("channels", MessagesSquare),
  entry("credentials", KeyRound),
  entry("appearance", Palette),
  entry("voice", Mic),
  entry("data", Trash2),
  entry("server", Server),
  entry("usage", Activity),
  entry("about", Info),
];

/** Sidebar groups, as System Settings groups its panes (docs/design/redesign-2026.md §5.8). */
export type SettingsGroupId = "general" | "access" | "devices" | "privacy" | "about";

export const SETTINGS_GROUPS: readonly {
  id: SettingsGroupId;
  sections: readonly SettingsSectionId[];
}[] = [
  { id: "general", sections: ["model", "persona", "appearance", "voice", "usage"] },
  {
    id: "access",
    sections: [
      "permissions",
      "connectors",
      "mcp",
      "skills",
      "credentials",
      "computer-use",
      "browser",
      "files",
    ],
  },
  { id: "devices", sections: ["devices", "channels", "vm", "server"] },
  { id: "privacy", sections: ["data"] },
  { id: "about", sections: ["about"] },
];

/** The section a setting key lives in, so the sidebar search finds sections by their settings. */
export function sectionForKey(key: string): SettingsSectionId | null {
  const root = key.split(".", 1)[0] ?? "";
  if (key.startsWith("permissions.folders")) return "files";
  const byRoot: Record<string, SettingsSectionId> = {
    appearance: "appearance",
    backup: "data",
    browser: "browser",
    computerUse: "computer-use",
    context: "model",
    data: "data",
    gateway: "server",
    models: "model",
    permissions: "permissions",
    persona: "persona",
    vm: "vm",
    voice: "voice",
    vault: "credentials",
    channels: "channels",
    mcp: "mcp",
    skills: "skills",
  };
  return byRoot[root] ?? null;
}

/** Sections whose name, or one of whose settings, matches the search (case-insensitive). */
export function matchSections(query: string): Set<SettingsSectionId> {
  const q = query.trim().toLocaleLowerCase();
  const out = new Set<SettingsSectionId>();
  for (const s of SETTINGS_SECTIONS) {
    if (q === "" || s.label.toLocaleLowerCase().includes(q)) out.add(s.id);
  }
  if (q !== "") {
    for (const [key, label] of Object.entries(SETTING_LABELS)) {
      const section = sectionForKey(key);
      if (section !== null && label.toLocaleLowerCase().includes(q)) out.add(section);
    }
  }
  return out;
}

/** Things only the shell knows or can do (OS permissions, OAuth windows, files, versions). */
export interface SettingsShellProps {
  now?: number;
  ramGb?: number;
  providers?: readonly ProviderInfo[];
  onRunModelCheck?: (modelRef: string) => void;
  onAddProvider?: () => void;
  onEditProviderKey?: (provider: ProviderInfo) => void;
  onDescribeChange?: (text: string) => void | Promise<void>;
  onConnect?: (type: string, mode: ScopeMode) => void;
  onReconnect?: (connector: Connector) => void;
  onDisconnect?: (connector: Connector) => void;
  onRemove?: (connector: Connector) => void;
  /** Desktop: a native folder chooser for Settings → Skills "Install a skill". */
  onPickSkillFolder?: () => Promise<string | null>;
  tcc?: Partial<Record<TccPermission, TccState>>;
  onOpenSystemSettings?: (permission: TccPermission) => void;
  vmMode?: boolean;
  thisDeviceId?: string;
  onConnectManager?: (manager: "1password" | "bitwarden") => void;
  /** Opens a task from a vault item's recent uses (Credentials). */
  onOpenTask?: (taskId: string) => void;
  onExportReady?: (file: ExportFile) => void;
  server?: ServerStatus;
  onAddPasskey?: () => void;
  onStartVm?: () => void;
  onStopVm?: () => void;
  onSetUpRemote?: () => void;
  usage?: UsageSummary | null;
  about?: AboutInfo | null;
  doctor?: readonly DoctorCheck[] | null;
  doctorRunning?: boolean;
  onRunDoctor?: () => void;
  onOpenLogs?: () => void;
  /** Desktop only: opens the Psyche Chrome profile (real-Chrome mode) in Google Chrome. */
  onOpenRealChromeProfile?: (profile: string) => Promise<{ path: string }>;
  /**
   * Section bodies the shell renders itself (for example a File access section backed by the
   * Gateway's `permissions.policy` with a native folder picker). Sections not listed here use
   * the kit's connected components.
   */
  sections?: Partial<Record<SettingsSectionId, ReactNode>>;
}

export interface SettingsScreenProps extends SettingsShellProps {
  /** Controlled section (from the `/settings/:section` route). */
  section?: SettingsSectionId;
  defaultSection?: SettingsSectionId;
  onSectionChange?: (section: SettingsSectionId) => void;
}

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function SettingsSectionView({
  section,
  shell,
  onOpenSection,
}: {
  section: SettingsSectionId;
  shell: SettingsShellProps;
  /** Moves to another section (the connector catalog's MCP and Slack rows). */
  onOpenSection?: (section: SettingsSectionId) => void;
}): ReactElement {
  const s = shell;
  const override = s.sections?.[section];
  if (override !== undefined) return <>{override}</>;
  switch (section) {
    case "model":
      return (
        <ModelSection
          {...opt("ramGb", s.ramGb)}
          {...opt("providers", s.providers)}
          {...opt("onRunCheck", s.onRunModelCheck)}
          {...opt("onAddProvider", s.onAddProvider)}
          {...opt("onEditKey", s.onEditProviderKey)}
        />
      );
    case "persona":
      return <PersonaSection {...opt("onDescribeChange", s.onDescribeChange)} />;
    case "connectors":
      return (
        <ConnectorsSection
          {...opt("now", s.now)}
          {...opt("onConnect", s.onConnect)}
          {...opt("onReconnect", s.onReconnect)}
          {...opt("onDisconnect", s.onDisconnect)}
          {...opt("onRemove", s.onRemove)}
          {...opt("onOpenSection", onOpenSection)}
        />
      );
    case "skills":
      return <SkillsSection {...opt("now", s.now)} {...opt("onPickFolder", s.onPickSkillFolder)} />;
    case "permissions":
      return <PermissionsSection {...opt("now", s.now)} />;
    case "computer-use":
      return (
        <ComputerUseSection
          {...opt("tcc", s.tcc)}
          {...opt("onOpenSystemSettings", s.onOpenSystemSettings)}
        />
      );
    case "browser":
      return <BrowserSection {...opt("onOpenProfile", s.onOpenRealChromeProfile)} />;
    case "files":
      return <FileAccessSection {...opt("vmMode", s.vmMode)} />;
    case "vm":
      return <VmSection {...opt("now", s.now)} />;
    case "devices":
      return <DevicesSection {...opt("now", s.now)} {...opt("thisDeviceId", s.thisDeviceId)} />;
    case "mcp":
      return <McpSection {...opt("now", s.now)} />;
    case "channels":
      return <ChannelsSection {...opt("now", s.now)} />;
    case "credentials":
      return (
        <CredentialsSection
          {...opt("now", s.now)}
          {...opt("onConnectManager", s.onConnectManager)}
          {...opt("onOpenTask", s.onOpenTask)}
        />
      );
    case "appearance":
      return <AppearanceSection />;
    case "voice":
      return <VoiceSection />;
    case "data":
      return <DataControlsSection {...opt("onExportReady", s.onExportReady)} />;
    case "server":
      return (
        <ServerSection
          {...opt("status", s.server)}
          {...opt("onAddPasskey", s.onAddPasskey)}
          {...opt("onStartVm", s.onStartVm)}
          {...opt("onStopVm", s.onStopVm)}
          {...opt("onSetUpRemote", s.onSetUpRemote)}
        />
      );
    case "usage":
      return <UsageSection usage={s.usage ?? null} />;
    case "about":
      return (
        <AboutSection
          info={s.about ?? null}
          doctor={s.doctor ?? null}
          doctorRunning={s.doctorRunning ?? false}
          {...opt("onRunDoctor", s.onRunDoctor)}
          {...opt("onOpenLogs", s.onOpenLogs)}
        />
      );
  }
}

export function SettingsScreen({
  section,
  defaultSection = "model",
  onSectionChange,
  ...shell
}: SettingsScreenProps): ReactElement {
  const { navigate } = useSlots();
  const [own, setOwn] = useState<SettingsSectionId>(defaultSection);
  const current = section ?? own;
  const navRef = useRef<HTMLElement>(null);

  const select = (id: SettingsSectionId) => {
    setOwn(id);
    onSectionChange?.(id);
    navigate?.(`/settings/${id}`);
  };

  const searchId = useId();
  const [query, setQuery] = useState("");
  const matches = useMemo(() => matchSections(query), [query]);
  const byId = useMemo(() => new Map(SETTINGS_SECTIONS.map((s) => [s.id, s])), []);

  const onNavKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const buttons = Array.from(navRef.current?.querySelectorAll("button") ?? []);
    if (buttons.length === 0) return;
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    e.preventDefault();
    buttons[next]?.focus();
  };

  // Two-pane (≥ 720 px): the selected row stays in view in the list, and a new section starts at
  // the top of the content pane. Stacked, neither pane scrolls on its own, so neither moves.
  const asideRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the section changes
  useEffect(() => {
    const aside = asideRef.current;
    if (aside === null || getComputedStyle(aside).overflowY !== "auto") return;
    const row = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    if (contentRef.current !== null) contentRef.current.scrollTop = 0;
  }, [current]);

  return (
    // The Settings window (§5.8), like System Settings: at ≥ 720 px a 248 px section list and the
    // content, each full height with its own scroll; narrower (the web on a phone) they stack. A
    // container query, so the screen's own width decides, not the window's.
    <div className="@container flex min-h-0 w-full flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-4 @min-[720px]:grid @min-[720px]:min-h-0 @min-[720px]:grid-cols-[248px_minmax(0,1fr)] @min-[720px]:gap-0">
        <aside
          ref={asideRef}
          className="flex flex-col bg-surface-sidebar px-2 pb-2 @min-[720px]:min-h-0 @min-[720px]:overflow-y-auto @min-[720px]:pb-3"
        >
          <h1 className="sr-only">{t("settings.nav.title")}</h1>
          {/* Pinned at the top of the list's scroll (h-11: the group headers stick under it). */}
          <div className="relative z-20 flex h-11 shrink-0 items-center bg-surface-sidebar px-1 @min-[720px]:sticky @min-[720px]:top-0">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute start-3 top-1/2 size-3.5 -translate-y-1/2 text-label-tertiary"
            />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  navRef.current?.querySelector("button")?.focus();
                }
              }}
              placeholder={t("settings.nav.search")}
              aria-label={t("settings.nav.search")}
              className="h-7 w-full rounded-md bg-fill-tertiary ps-7 pe-2 text-body text-label-primary outline-none placeholder:text-label-tertiary focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <nav aria-label={t("settings.nav.label")} ref={navRef} onKeyDown={onNavKey}>
            {matches.size === 0 ? (
              <p className="px-3 py-2 text-callout text-label-secondary" role="status">
                {t("settings.nav.noMatch")}
              </p>
            ) : null}
            {SETTINGS_GROUPS.map((g) => {
              const shown = g.sections.filter((id) => matches.has(id));
              if (shown.length === 0) return null;
              return (
                <div key={g.id} className="mb-3 flex flex-col gap-0.5">
                  <h2 className="z-10 bg-surface-sidebar px-3 pb-0.5 text-caption text-label-tertiary @min-[720px]:sticky @min-[720px]:top-11">
                    {t(`settings.nav.group.${g.id}`)}
                  </h2>
                  <ul className="flex flex-col gap-px">
                    {shown.map((id) => {
                      const s = byId.get(id);
                      if (s === undefined) return null;
                      const active = id === current;
                      const Icon = s.icon;
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            aria-current={active ? "page" : undefined}
                            onClick={() => select(id)}
                            className={cn(
                              "flex h-7 w-full cursor-default scroll-mt-16 items-center gap-2 rounded-sm px-2 text-start text-body outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              active
                                ? "bg-selection text-label-primary"
                                : "text-label-primary hover:bg-fill-quaternary",
                            )}
                          >
                            <Icon
                              className={cn(
                                "size-4 shrink-0",
                                active ? "text-accent-11" : "text-label-secondary",
                              )}
                              strokeWidth={1.75}
                              aria-hidden="true"
                            />
                            <span className="truncate">{s.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </nav>
        </aside>
        <div
          ref={contentRef}
          className="flex min-w-0 flex-col gap-5 bg-canvas px-6 py-5 @min-[720px]:min-h-0 @min-[720px]:overflow-y-auto @min-[720px]:px-8"
        >
          <div className="flex w-full max-w-[680px] flex-col gap-5">
            <SettingsApprovalProvider>
              <SettingsSectionView section={current} shell={shell} onOpenSection={select} />
            </SettingsApprovalProvider>
          </div>
        </div>
      </div>
    </div>
  );
}
