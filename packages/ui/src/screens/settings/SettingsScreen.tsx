import type { Connector } from "@psyche/protocol";
import { Search } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { UsageSummary } from "../../fixtures/index.ts";
import { t } from "../../i18n/core.ts";
import { documentPrefersReducedMotion, smoothScrollBehavior } from "../../lib/reduced-motion.ts";
import { cn } from "../../lib/utils.ts";
import { useSlots } from "../../slots.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { BrowserSection, type SignedInSitesApi } from "./BrowserSection.tsx";
import { ChannelsSection } from "./ChannelsSection.tsx";
import { ComputerUseSection } from "./ComputerUseSection.tsx";
import { ConnectorsSection, type ConnectorsView, type ScopeMode } from "./ConnectorsSection.tsx";
import { CredentialsSection } from "./CredentialsSection.tsx";
import { DailySection } from "./DailySection.tsx";
import {
  DataControlsSection,
  type ExportFile,
  MemoryControlsSection,
} from "./DataControlsSection.tsx";
import { DevicesSection } from "./DevicesSection.tsx";
import { EverythingMemorySection } from "./EverythingMemorySection.tsx";
import { FileAccessSection } from "./FileAccessSection.tsx";
import { MailMeetingsSection } from "./MailMeetingsSection.tsx";
import { MemoryReviewSection } from "./MemoryReviewSection.tsx";
import { ModelSection } from "./ModelSection.tsx";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { PeopleSection } from "./PeopleSection.tsx";
import { PermissionsSection } from "./PermissionsSection.tsx";
import { PersonaSection } from "./PersonaSection.tsx";
import { SearchSection } from "./SearchSection.tsx";
import { ServerSection } from "./ServerSection.tsx";
import { SettingsApprovalProvider } from "./SettingsApproval.tsx";
import { SkillsSection } from "./SkillsSection.tsx";
import { SpecialistsSection } from "./SpecialistsSection.tsx";
import { SETTING_LABELS } from "./setting-labels.ts";
import {
  pageById,
  pageOfPane,
  paneById,
  paneForKey,
  resolveSection,
  SETTINGS_PAGES,
  SETTINGS_PANES,
  type SettingsPage,
  type SettingsPaneId,
  type SettingsSectionId,
} from "./settings-pages.ts";
import { InPageContext } from "./shared.tsx";
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

/**
 * Settings (UI design §2.6, §3.18; docs/design/settings-2026.md): nine pages in the sidebar, each
 * a column of panes, and a search that jumps to the setting itself.
 */

export {
  paneForKey,
  SETTINGS_PAGES,
  SETTINGS_PANES,
  SETTINGS_SECTIONS,
  type SettingsPage,
  type SettingsPageId,
  type SettingsPaneId,
  type SettingsSectionId,
} from "./settings-pages.ts";

/** One search result: a page, a pane, or a single setting inside a pane. */
export interface SettingsHit {
  kind: "page" | "pane" | "setting";
  label: string;
  page: SettingsPage;
  pane?: SettingsPaneId;
  /** The setting key to scroll to (its row carries `data-setting-key`). */
  settingKey?: string;
}

/**
 * What the sidebar search finds, best first: pages and panes by name, then settings by their
 * label, each with the page and pane it opens. Every word of the query has to appear.
 */
export function searchSettings(query: string): SettingsHit[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hits: SettingsHit[] = [];
  const seen = new Set<string>();
  const add = (hit: SettingsHit, text: string) => {
    const hay = text.toLocaleLowerCase();
    if (!words.every((w) => hay.includes(w))) return;
    const id = `${hit.label}|${hit.pane ?? hit.page.id}`;
    if (seen.has(id)) return;
    seen.add(id);
    hits.push(hit);
  };
  for (const p of SETTINGS_PAGES) add({ kind: "page", label: p.label, page: p }, p.label);
  for (const pane of SETTINGS_PANES) {
    const p = pageOfPane(pane.id);
    add({ kind: "pane", label: pane.label, page: p, pane: pane.id }, pane.label);
  }
  for (const [key, label] of Object.entries(SETTING_LABELS)) {
    const pane = paneForKey(key);
    if (pane === null) continue;
    add({ kind: "setting", label, page: pageOfPane(pane), pane, settingKey: key }, label);
  }
  const first = words[0] ?? "";
  // Labels that start with the query rank first; the order above breaks ties.
  return hits
    .map((h, i) => ({ h, i, starts: h.label.toLocaleLowerCase().startsWith(first) ? 0 : 1 }))
    .sort((a, b) => a.starts - b.starts || a.i - b.i)
    .map((x) => x.h);
}

/** The sub-line under a search result: where it opens. */
function hitPath(hit: SettingsHit): string {
  if (hit.kind === "page") return t("settings.search.result.page");
  const pane = hit.pane === undefined ? undefined : paneById(hit.pane);
  if (hit.kind === "pane" || pane === undefined || hit.page.panes.length === 1)
    return hit.page.label;
  return `${hit.page.label} › ${pane.label}`;
}

const paneAnchor = (id: SettingsPaneId) => `settings-pane-${id}`;

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
  /** Desktop only: sites "Stay signed in" kept in the profile (Settings → Browser). */
  signedInSites?: SignedInSitesApi;
  /**
   * Pane bodies the shell renders itself (for example a File access section backed by the
   * Gateway's `permissions.policy` with a native folder picker). Sections not listed here use
   * the kit's connected components.
   */
  sections?: Partial<Record<SettingsPaneId, ReactNode>>;
}

export interface SettingsScreenProps extends SettingsShellProps {
  /** Controlled page or pane (from the `/settings/:section` route; a pane scrolls into view). */
  section?: SettingsSectionId;
  defaultSection?: SettingsSectionId;
  onSectionChange?: (section: SettingsSectionId) => void;
  /** Where Connectors opens: the MCP servers only, or with the Add MCP server form showing. */
  connectorsView?: ConnectorsView;
  /** Opens with this typed in Search settings (stories). */
  defaultQuery?: string;
}

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

export function SettingsSectionView({
  section,
  shell,
  onOpenSection,
  connectorsView,
}: {
  section: SettingsPaneId;
  shell: SettingsShellProps;
  /** Moves to another section (the connector catalog's Slack row). */
  onOpenSection?: (section: SettingsSectionId) => void;
  /** Where Connectors opens (the old MCP route, ⌘K "Add MCP server"). */
  connectorsView?: ConnectorsView;
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
          {...opt("view", connectorsView)}
        />
      );
    case "skills":
      return <SkillsSection {...opt("now", s.now)} {...opt("onPickFolder", s.onPickSkillFolder)} />;
    case "specialists":
      return <SpecialistsSection />;
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
      return (
        <BrowserSection
          {...opt("onOpenProfile", s.onOpenRealChromeProfile)}
          {...opt("signedInSites", s.signedInSites)}
        />
      );
    case "files":
      return <FileAccessSection {...opt("vmMode", s.vmMode)} />;
    case "vm":
      return <VmSection {...opt("now", s.now)} />;
    case "devices":
      return <DevicesSection {...opt("now", s.now)} {...opt("thisDeviceId", s.thisDeviceId)} />;
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
    case "notifications":
      return <NotificationsSection />;
    case "voice":
      return <VoiceSection />;
    case "mail":
      return <MailMeetingsSection />;
    case "daily":
      return <DailySection />;
    case "data":
      return <DataControlsSection {...opt("onExportReady", s.onExportReady)} />;
    case "people":
      return <PeopleSection />;
    case "everything":
      return <EverythingMemorySection />;
    case "memory":
      return <MemoryReviewSection />;
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
    case "search":
      return <SearchSection />;
    case "learning":
      return <MemoryControlsSection />;
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

/** Briefly tints a row Search jumped to, so the eye lands on it (no tint under reduced motion). */
function flash(el: HTMLElement): void {
  if (typeof el.animate !== "function" || documentPrefersReducedMotion()) return;
  const tint = getComputedStyle(document.documentElement).getPropertyValue("--selection").trim();
  if (tint === "") return;
  el.animate([{ backgroundColor: tint }, { backgroundColor: tint, offset: 0.6 }, {}], {
    duration: 1600,
    easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  });
}

/** One sidebar row: a page (icon, label) or, under the open page, one of its panes. */
function NavRow({
  label,
  icon: Icon,
  current,
  sub = false,
  onSelect,
}: {
  label: string;
  icon?: SettingsPage["icon"];
  current: boolean;
  sub?: boolean;
  onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-current={current ? (sub ? "location" : "page") : undefined}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-default scroll-mt-16 items-center gap-2 rounded-sm px-2 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        sub ? "h-6 ps-8 text-callout" : "h-7 text-body",
        current && !sub
          ? "bg-selection text-label-primary"
          : current
            ? "font-medium text-label-primary"
            : sub
              ? "text-label-secondary hover:bg-fill-quaternary hover:text-label-primary"
              : "text-label-primary hover:bg-fill-quaternary",
      )}
    >
      {Icon ? (
        <Icon
          className={cn("size-4 shrink-0", current ? "text-accent-11" : "text-label-secondary")}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      ) : null}
      <span className="truncate">{label}</span>
    </button>
  );
}

export function SettingsScreen({
  section,
  defaultSection = "general",
  onSectionChange,
  connectorsView,
  defaultQuery = "",
  ...shell
}: SettingsScreenProps): ReactElement {
  const { navigate } = useSlots();
  const [own, setOwn] = useState<SettingsSectionId>(defaultSection);
  const target = resolveSection(section ?? own);
  const page = pageById(target.page);
  const multi = page.panes.length > 1;
  const navRef = useRef<HTMLElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Bumped on every jump, so choosing the same pane or setting again scrolls to it again.
  const [jump, setJump] = useState(0);
  const pendingKey = useRef<string | null>(null);
  // The pane at the top of the content (two-pane layout), for the sidebar's current sub-row.
  const [inView, setInView] = useState<SettingsPaneId | null>(null);

  const select = (id: SettingsSectionId, settingKey?: string) => {
    pendingKey.current = settingKey ?? null;
    setOwn(id);
    setJump((n) => n + 1);
    onSectionChange?.(id);
    navigate?.(`/settings/${id}`);
  };

  const searchId = useId();
  const [query, setQuery] = useState(defaultQuery);
  const hits = useMemo(() => searchSettings(query).slice(0, 40), [query]);
  const searching = query.trim() !== "";

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

  const open = (hit: SettingsHit) => {
    setQuery("");
    select(hit.pane ?? hit.page.id, hit.settingKey);
  };

  // A new page starts at the top; a pane, or a setting Search found, scrolls into view. Panes load
  // their settings after they mount, so a setting row is looked for again for a moment.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the target changes
  useEffect(() => {
    const content = contentRef.current;
    if (content === null) return;
    const key = pendingKey.current;
    pendingKey.current = null;
    // The first pane is the top of its page: the page title stays in view.
    const paneEl =
      target.pane === undefined || target.pane === page.panes[0]
        ? null
        : content.querySelector<HTMLElement>(`#${paneAnchor(target.pane)}`);
    const show = (el: HTMLElement, block: ScrollLogicalPosition) => {
      if (typeof el.scrollIntoView === "function")
        el.scrollIntoView({ block, behavior: smoothScrollBehavior() });
    };
    if (paneEl !== null) show(paneEl, "start");
    else if (getComputedStyle(content).overflowY === "auto") content.scrollTop = 0;
    if (key === null) return;
    let tries = 0;
    const timer = setInterval(() => {
      const row = content.querySelector<HTMLElement>(
        `[data-setting-key="${key.replace(/["\\]/g, "\\$&")}"]`,
      );
      if (row !== null) {
        clearInterval(timer);
        show(row, "center");
        flash(row);
      } else if (++tries > 20) clearInterval(timer);
    }, 75);
    return () => clearInterval(timer);
  }, [target.page, target.pane, jump]);

  // Two-pane (≥ 720 px): the open page stays in view in the list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the page changes
  useEffect(() => {
    const aside = asideRef.current;
    if (aside === null || getComputedStyle(aside).overflowY !== "auto") return;
    const row = navRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [target.page]);

  // Which pane is at the top of the content as it scrolls (two-pane only; stacked, the window
  // scrolls and the sub-row follows the last pane chosen).
  const onContentScroll = useCallback(() => {
    const content = contentRef.current;
    if (content === null || !multi) return;
    const top = content.getBoundingClientRect().top + 96;
    let current: SettingsPaneId | null = null;
    for (const el of content.querySelectorAll<HTMLElement>("[data-settings-pane]")) {
      if (el.getBoundingClientRect().top <= top)
        current = el.dataset.settingsPane as SettingsPaneId;
    }
    setInView(current);
  }, [multi]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets when the page changes
  useEffect(() => setInView(null), [target.page]);
  const currentPane = inView ?? target.pane ?? page.panes[0];

  return (
    // The Settings window (§5.8), like System Settings: at ≥ 720 px a 248 px page list and the
    // content, each full height with its own scroll; narrower (the web on a phone) they stack. A
    // container query, so the screen's own width decides, not the window's.
    <div className="@container flex min-h-0 w-full flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-4 @min-[720px]:grid @min-[720px]:min-h-0 @min-[720px]:grid-cols-[248px_minmax(0,1fr)] @min-[720px]:gap-0">
        <aside
          ref={asideRef}
          className="flex flex-col bg-surface-sidebar px-2 pb-2 @min-[720px]:min-h-0 @min-[720px]:overflow-y-auto @min-[720px]:pb-3"
        >
          <h1 className="sr-only">{t("settings.nav.title")}</h1>
          {/* Pinned at the top of the list's scroll. */}
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
                } else if (e.key === "Enter" && hits[0] !== undefined) {
                  e.preventDefault();
                  open(hits[0]);
                } else if (e.key === "Escape" && query !== "") {
                  e.preventDefault();
                  setQuery("");
                }
              }}
              placeholder={t("settings.nav.find")}
              aria-label={t("settings.nav.find")}
              aria-controls={`${searchId}-nav`}
              className="h-7 w-full rounded-md bg-fill-tertiary ps-7 pe-2 text-body text-label-primary outline-none placeholder:text-label-tertiary focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <nav
            id={`${searchId}-nav`}
            aria-label={t("settings.nav.label")}
            ref={navRef}
            onKeyDown={onNavKey}
          >
            {searching ? (
              hits.length === 0 ? (
                <p className="px-3 py-2 text-callout text-label-secondary" role="status">
                  {t("settings.nav.noMatch")}
                </p>
              ) : (
                <>
                  <p className="sr-only" role="status">
                    {t("settings.search.count", { count: hits.length })}
                  </p>
                  <ul className="flex flex-col gap-px">
                    {hits.map((hit) => (
                      <li key={`${hit.kind}:${hit.settingKey ?? hit.pane ?? hit.page.id}`}>
                        <button
                          type="button"
                          onClick={() => open(hit)}
                          className="flex w-full cursor-default flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-start outline-none transition-colors hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="w-full truncate text-body text-label-primary">
                            {hit.label}
                          </span>
                          <span className="w-full truncate text-callout text-label-secondary">
                            {hitPath(hit)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )
            ) : (
              <ul className="flex flex-col gap-px">
                {SETTINGS_PAGES.map((p) => {
                  const active = p.id === page.id;
                  return (
                    <li key={p.id}>
                      <NavRow
                        label={p.label}
                        icon={p.icon}
                        current={active}
                        onSelect={() => select(p.id)}
                      />
                      {active && multi ? (
                        <ul
                          className="flex flex-col gap-px pt-px pb-1"
                          aria-label={t("settings.nav.inPage", { page: p.label })}
                        >
                          {p.panes.map((id) => (
                            <li key={id}>
                              <NavRow
                                label={paneById(id)?.label ?? id}
                                current={id === currentPane}
                                sub
                                onSelect={() => select(id)}
                              />
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </nav>
        </aside>
        <div
          ref={contentRef}
          onScroll={onContentScroll}
          className="flex min-w-0 flex-col bg-canvas px-6 py-5 @min-[720px]:min-h-0 @min-[720px]:overflow-y-auto @min-[720px]:px-8"
        >
          <div className="flex w-full max-w-[680px] flex-col gap-10 pb-8">
            <SettingsApprovalProvider>
              <InPageContext.Provider value={multi}>
                {multi ? (
                  <header className="-mb-4 flex flex-col gap-1">
                    <h2 className="font-display text-page-title text-label-primary">
                      {page.label}
                    </h2>
                    <p className="text-callout text-label-secondary">{page.description}</p>
                  </header>
                ) : null}
                {page.panes.map((id, i) => (
                  <div
                    key={id}
                    id={paneAnchor(id)}
                    data-settings-pane={id}
                    className={cn(
                      "flex scroll-mt-5 flex-col gap-5",
                      multi && i > 0 && "border-t border-separator pt-8",
                    )}
                  >
                    <SettingsSectionView
                      section={id}
                      shell={shell}
                      onOpenSection={select}
                      {...(connectorsView === undefined || id !== "connectors"
                        ? {}
                        : { connectorsView })}
                    />
                  </div>
                ))}
              </InPageContext.Provider>
            </SettingsApprovalProvider>
          </div>
        </div>
      </div>
    </div>
  );
}
