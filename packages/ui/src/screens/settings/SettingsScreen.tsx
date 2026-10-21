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
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, type ReactElement, type ReactNode, useRef, useState } from "react";
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
  const navRef = useRef<HTMLUListElement>(null);

  const select = (id: SettingsSectionId) => {
    setOwn(id);
    onSectionChange?.(id);
    navigate?.(`/settings/${id}`);
  };

  const onNavKey = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const buttons = Array.from(navRef.current?.querySelectorAll("button") ?? []);
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

  return (
    <div className="flex min-h-0 flex-col gap-4 md:grid md:grid-cols-[14rem_minmax(0,1fr)] md:gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="text-h1 text-foreground">{t("settings.nav.title")}</h1>
        <nav aria-label={t("settings.nav.label")}>
          <ul ref={navRef} onKeyDown={onNavKey} className="flex flex-col gap-0.5">
            {SETTINGS_SECTIONS.map((s) => {
              const active = s.id === current;
              const Icon = s.icon;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    onClick={() => select(s.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-accent-3 font-medium text-accent-12"
                        : "text-gray-11 hover:bg-gray-3 hover:text-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    {s.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <div className="flex min-w-0 max-w-[var(--page-width)] flex-col gap-4">
        <SettingsApprovalProvider>
          <SettingsSectionView section={current} shell={shell} onOpenSection={select} />
        </SettingsApprovalProvider>
      </div>
    </div>
  );
}
