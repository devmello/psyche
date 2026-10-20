import { Lock } from "lucide-react";
import { type ReactElement, useId } from "react";
import { Button } from "../../components/ui/button.tsx";
import { Kbd } from "../../components/ui/kbd.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.tsx";
import { usePersona } from "../../slots.tsx";
import {
  bool,
  EmptyNotice,
  ErrorNotice,
  Group,
  LoadGate,
  type LoadProps,
  SectionFrame,
  SettingHint,
  type SettingsFormProps,
  StatusChip,
  SwitchField,
  useSettingsForm,
} from "./shared.tsx";
import type { AppTier, ComputerUseApp, TccPermission, TccState } from "./types.ts";

/** Computer use (UI design §3.18; architecture §6). */

export const TIERS: readonly { value: AppTier; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "off", label: "Off" },
  { value: "read", label: "Read only" },
  { value: "interact", label: "Read and interact" },
];

/** Fixed caps (architecture §6): browsers read-only, terminals and IDEs click-only, money Off. */
export const LOCKED_APPS: readonly ComputerUseApp[] = [
  {
    id: "com.apple.Safari",
    name: "Safari",
    tier: "read",
    locked: {
      cap: "read",
      reason: "Browsers are read only; the agent browses in its own browser.",
    },
  },
  {
    id: "com.google.Chrome",
    name: "Google Chrome",
    tier: "read",
    locked: {
      cap: "read",
      reason: "Browsers are read only; the agent browses in its own browser.",
    },
  },
  {
    id: "com.apple.Terminal",
    name: "Terminal",
    tier: "read",
    locked: { cap: "click", reason: "Terminals are click only; commands run in the sandbox." },
  },
  {
    id: "com.microsoft.VSCode",
    name: "Visual Studio Code",
    tier: "read",
    locked: { cap: "click", reason: "IDEs are click only; no typing into editors." },
  },
  {
    id: "com.1password.1password",
    name: "1Password",
    tier: "off",
    locked: { cap: "off", reason: "Password managers are always off." },
  },
  {
    id: "banking",
    name: "Banking and trading apps",
    tier: "off",
    locked: { cap: "off", reason: "Banking and trading apps are always off." },
  },
];

const CAP_LABEL = { read: "Read only (fixed)", click: "Click only (fixed)", off: "Off (fixed)" };

export const TCC_LABEL: Record<TccPermission, { name: string; why: string }> = {
  accessibility: { name: "Accessibility", why: "lets the agent click, type and use apps" },
  screenRecording: { name: "Screen Recording", why: "lets the agent see app windows" },
  notifications: {
    name: "Notifications",
    why: "lets Psyche ask for approvals when the window is closed",
  },
};

const TCC_STATE: Record<TccState, { tone: "success" | "danger" | "neutral"; text: string }> = {
  granted: { tone: "success", text: "Granted" },
  denied: { tone: "danger", text: "Denied" },
  not_determined: { tone: "neutral", text: "Not asked yet" },
};

function isApp(v: unknown): v is ComputerUseApp {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as ComputerUseApp).id === "string" &&
    typeof (v as ComputerUseApp).name === "string" &&
    TIERS.some((t) => t.value === (v as ComputerUseApp).tier)
  );
}

export function appsFromSettings(values: Readonly<Record<string, unknown>>): ComputerUseApp[] {
  const raw = values["computerUse.apps"];
  return Array.isArray(raw) ? raw.filter(isApp) : [];
}

export interface ComputerUsePanelProps extends SettingsFormProps, LoadProps {
  persona: string;
  tcc: Partial<Record<TccPermission, TccState>>;
  /** Opens System Settings at the pane for `permission` (the shell asks macOS). */
  onOpenSystemSettings?: (permission: TccPermission) => void;
}

export function ComputerUsePanel({
  values,
  onChange,
  needsApproval,
  persona,
  tcc,
  onOpenSystemSettings,
  loading,
  error,
  onRetry,
}: ComputerUsePanelProps): ReactElement {
  const id = useId();
  const enabled = bool(values, "computerUse.enabled", false);
  const apps = appsFromSettings(values);
  const setTier = (app: ComputerUseApp, tier: AppTier) =>
    onChange(
      "computerUse.apps",
      apps.map((a) => (a.id === app.id ? { ...a, tier } : a)),
    );

  return (
    <SectionFrame
      needsApproval={needsApproval}
      title="Computer use"
      description={
        <>
          {persona} can use apps on this Mac only where you allow it. <Kbd>Esc</Kbd> stops computer
          use at any time.
        </>
      }
    >
      <LoadGate
        label="computer use"
        loading={loading ?? false}
        error={error ?? null}
        {...(onRetry ? { onRetry } : {})}
      >
        <Group title="macOS permissions">
          <ul className="flex flex-col gap-2">
            {(["accessibility", "screenRecording"] as const).map((p) => {
              const state = tcc[p] ?? "not_determined";
              return (
                <li key={p} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{TCC_LABEL[p].name}</span>
                  <StatusChip tone={TCC_STATE[state].tone}>{TCC_STATE[state].text}</StatusChip>
                  <span className="text-xs text-muted-foreground">{TCC_LABEL[p].why}</span>
                  {state !== "granted" && onOpenSystemSettings ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="ml-auto"
                      onClick={() => onOpenSystemSettings(p)}
                      aria-label={`Open System Settings for ${TCC_LABEL[p].name}`}
                    >
                      Open System Settings
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Group>

        <Group title="Apps">
          <SwitchField
            label="Allow computer use"
            description="Off stops every app below. Each app is asked about on first use."
            checked={enabled}
            settingKey="computerUse.enabled"
            onChange={(v) => onChange("computerUse.enabled", v)}
          />
          <SettingHint settingKey="computerUse.apps" />
          <Table aria-label="App access">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">App</TableHead>
                {TIERS.map((t) => (
                  <TableHead key={t.value} scope="col" className="text-center">
                    {t.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={TIERS.length + 1}>
                    <EmptyNotice text="No apps yet. Apps appear here the first time they're used." />
                  </TableCell>
                </TableRow>
              ) : null}
              {apps.map((a) => (
                <TableRow key={a.id}>
                  <th scope="row" className="p-2 text-left font-normal">
                    {a.name}
                  </th>
                  {TIERS.map((t) => (
                    <TableCell key={t.value} className="text-center">
                      <input
                        type="radio"
                        name={`${id}-${a.id}`}
                        value={t.value}
                        checked={a.tier === t.value}
                        disabled={!enabled}
                        onChange={() => setTier(a, t.value)}
                        aria-label={`${a.name}: ${t.label}`}
                        className="size-4 accent-accent-9"
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {LOCKED_APPS.map((a) => (
                <TableRow key={a.id} data-locked="true">
                  <th scope="row" className="p-2 text-left font-normal">
                    <span className="flex items-center gap-1.5">
                      <Lock className="size-3.5 text-gray-11" aria-hidden="true" />
                      {a.name}
                    </span>
                  </th>
                  <TableCell colSpan={TIERS.length} className="whitespace-normal">
                    <span className="font-medium">{a.locked ? CAP_LABEL[a.locked.cap] : ""}</span>{" "}
                    <span className="text-xs text-muted-foreground">{a.locked?.reason}</span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Group>
      </LoadGate>
    </SectionFrame>
  );
}

export interface ComputerUseSectionProps {
  tcc?: Partial<Record<TccPermission, TccState>>;
  onOpenSystemSettings?: (permission: TccPermission) => void;
}

export function ComputerUseSection({
  tcc = {},
  onOpenSystemSettings,
}: ComputerUseSectionProps): ReactElement {
  const form = useSettingsForm();
  const persona = usePersona();
  return (
    <div className="flex flex-col gap-3">
      <ComputerUsePanel
        values={form.values}
        onChange={form.onChange}
        needsApproval={form.needsApproval}
        persona={persona.name}
        tcc={tcc}
        loading={form.loading && Object.keys(form.values).length === 0}
        error={form.error}
        onRetry={form.reload}
        {...(onOpenSystemSettings ? { onOpenSystemSettings } : {})}
      />
      {form.writeError ? <ErrorNotice what={form.writeError} did="" /> : null}
    </div>
  );
}
