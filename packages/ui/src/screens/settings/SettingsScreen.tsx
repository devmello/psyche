import type { Connector } from "@psyche/protocol";
import {
  Activity,
  Bot,
  FolderLock,
  Info,
  KeyRound,
  type LucideIcon,
  MessagesSquare,
  Mic,
  MonitorSmartphone,
  MousePointerClick,
  Palette,
  Plug,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import { type KeyboardEvent, type ReactElement, type ReactNode, useRef, useState } from "react";
import type { UsageSummary } from "../../fixtures/index.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { ChannelsSection } from "./ChannelsSection.tsx";
import { ComputerUseSection } from "./ComputerUseSection.tsx";
import { ConnectorsSection, type ScopeMode } from "./ConnectorsSection.tsx";
import { CredentialsSection } from "./CredentialsSection.tsx";
import { DataControlsSection, type ExportFile } from "./DataControlsSection.tsx";
import { DevicesSection } from "./DevicesSection.tsx";
import { FileAccessSection } from "./FileAccessSection.tsx";
import { ModelSection } from "./ModelSection.tsx";
import { PermissionsSection } from "./PermissionsSection.tsx";
import { PersonaSection } from "./PersonaSection.tsx";
import { ServerSection } from "./ServerSection.tsx";
import type {
  AboutInfo,
  DoctorCheck,
  ProviderInfo,
  ServerStatus,
  TccPermission,
  TccState,
} from "./types.ts";
import { UsageSection } from "./UsageSection.tsx";
import { VoiceSection } from "./VoiceSection.tsx";

/** Settings (UI design §2.6, §3.18): a section nav and one component per section. */

export type SettingsSectionId =
  | "model"
  | "persona"
  | "connectors"
  | "permissions"
  | "computer-use"
  | "files"
  | "devices"
  | "channels"
  | "credentials"
  | "appearance"
  | "voice"
  | "data"
  | "server"
  | "usage"
  | "about";

export const SETTINGS_SECTIONS: readonly {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "model", label: "Model & providers", icon: Bot },
  { id: "persona", label: "Persona", icon: Sparkles },
  { id: "connectors", label: "Connectors", icon: Plug },
  { id: "permissions", label: "Permissions", icon: ShieldCheck },
  { id: "computer-use", label: "Computer use", icon: MousePointerClick },
  { id: "files", label: "File access", icon: FolderLock },
  { id: "devices", label: "Devices & nodes", icon: MonitorSmartphone },
  { id: "channels", label: "Channels", icon: MessagesSquare },
  { id: "credentials", label: "Credentials", icon: KeyRound },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "voice", label: "Voice & dictation", icon: Mic },
  { id: "data", label: "Data controls", icon: Trash2 },
  { id: "server", label: "Server & remote access", icon: Server },
  { id: "usage", label: "Usage", icon: Activity },
  { id: "about", label: "About", icon: Info },
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
  tcc?: Partial<Record<TccPermission, TccState>>;
  onOpenSystemSettings?: (permission: TccPermission) => void;
  vmMode?: boolean;
  thisDeviceId?: string;
  onConnectManager?: (manager: "1password" | "bitwarden") => void;
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
}: {
  section: SettingsSectionId;
  shell: SettingsShellProps;
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
        />
      );
    case "permissions":
      return <PermissionsSection {...opt("now", s.now)} />;
    case "computer-use":
      return (
        <ComputerUseSection
          {...opt("tcc", s.tcc)}
          {...opt("onOpenSystemSettings", s.onOpenSystemSettings)}
        />
      );
    case "files":
      return <FileAccessSection {...opt("vmMode", s.vmMode)} />;
    case "devices":
      return <DevicesSection {...opt("now", s.now)} {...opt("thisDeviceId", s.thisDeviceId)} />;
    case "channels":
      return <ChannelsSection {...opt("now", s.now)} />;
    case "credentials":
      return (
        <CredentialsSection
          {...opt("now", s.now)}
          {...opt("onConnectManager", s.onConnectManager)}
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
        <h1 className="text-h1 text-foreground">Settings</h1>
        <nav aria-label="Settings sections">
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
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
      <div className="min-w-0 max-w-[var(--page-width)]">
        <SettingsSectionView section={current} shell={shell} />
      </div>
    </div>
  );
}
