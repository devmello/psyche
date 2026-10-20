import { isAdminSettingKey } from "@psyche/protocol";
import { CircleAlert, ShieldAlert } from "lucide-react";
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
} from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { useSettings } from "../../data/hooks.ts";
import { cn } from "../../lib/utils.ts";

/**
 * Building blocks shared by the settings sections (UI design §3.18, shared states §3.0): section
 * and group frames, loading / empty / error states, labelled radio and switch fields, and the
 * settings writer that turns a `forbidden` answer on an admin key into a visible hint.
 */

export type SettingsValues = Readonly<Record<string, unknown>>;

/** What a settings-backed section needs: current values, a writer and the admin hints. */
export interface SettingsFormProps {
  values: SettingsValues;
  onChange: (key: string, value: unknown) => void;
  /** Admin-only keys whose last write was refused with `forbidden` on this device. */
  needsApproval?: ReadonlySet<string>;
}

export function str(values: SettingsValues, key: string, fallback: string): string {
  const v = values[key];
  return typeof v === "string" ? v : fallback;
}

export function bool(values: SettingsValues, key: string, fallback: boolean): boolean {
  const v = values[key];
  return typeof v === "boolean" ? v : fallback;
}

export function num(values: SettingsValues, key: string, fallback: number): number {
  const v = values[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** `true` when `err` carries the Gateway error code `code`. */
export function hasCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === code;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `useSettings()` plus error handling for writes: an admin key refused with `forbidden` lands in
 * `needsApproval` (shown as "Needs approval on this device"); anything else in `writeError`.
 */
export function useSettingsForm() {
  const { settings, set, loading, error, reload } = useSettings();
  const [needsApproval, setNeedsApproval] = useState<ReadonlySet<string>>(() => new Set());
  const [writeError, setWriteError] = useState<string | null>(null);

  const onChange = useCallback(
    (key: string, value: unknown) => {
      setWriteError(null);
      set(key, value).then(
        () =>
          setNeedsApproval((prev) => {
            if (!prev.has(key)) return prev;
            const next = new Set(prev);
            next.delete(key);
            return next;
          }),
        (err: unknown) => {
          if (hasCode(err, "forbidden") && isAdminSettingKey(key)) {
            setNeedsApproval((prev) => new Set(prev).add(key));
          } else {
            setWriteError(`Psyche couldn't save ${key} (${messageOf(err)}). Nothing changed.`);
          }
        },
      );
    },
    [set],
  );

  return { values: settings, onChange, needsApproval, writeError, loading, error, reload };
}

// --- Frames ------------------------------------------------------------------------------------

const NeedsApprovalContext = createContext<ReadonlySet<string>>(new Set());

/** `true` when the last write of `key` was refused with `forbidden` (inside a SectionFrame). */
export function useNeedsApproval(key: string | undefined): boolean {
  const keys = useContext(NeedsApprovalContext);
  return key !== undefined && keys.has(key);
}

/** "Needs approval on this device" under a field whose admin key was refused. */
export function SettingHint({ settingKey }: { settingKey: string }): ReactElement | null {
  return <AdminHint show={useNeedsApproval(settingKey)} />;
}

const NO_KEYS: ReadonlySet<string> = new Set();

export function SectionFrame({
  title,
  description,
  children,
  actions,
  needsApproval = NO_KEYS,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Admin keys refused on this device; fields with a matching `settingKey` show a hint. */
  needsApproval?: ReadonlySet<string> | undefined;
}): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
      {/* PageHeader's layout one level down: Settings owns the page's h1, each section an h2. */}
      <header className="mb-2 flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id={id} className="text-h2 text-foreground">
            {title}
          </h2>
          {description ? <p className="text-small text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <NeedsApprovalContext.Provider value={needsApproval}>
        {children}
      </NeedsApprovalContext.Provider>
    </section>
  );
}

export function Group({
  title,
  description,
  children,
  actions,
  className,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}): ReactElement {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("elevation-1 rounded-lg p-4 text-sm", className)}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 id={id} className="text-h3 text-foreground">
            {title}
          </h3>
          {description ? (
            <p className="mt-0.5 text-small text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children ? <div className="mt-4 flex flex-col gap-4">{children}</div> : null}
    </section>
  );
}

// --- States ------------------------------------------------------------------------------------

export function SectionSkeleton({
  label,
  rows = 3,
}: {
  label: string;
  rows?: number;
}): ReactElement {
  return (
    <div role="status" aria-label={`Loading ${label}`} className="flex flex-col gap-3">
      <Skeleton className="h-6 w-48" />
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((k) => (
        <Skeleton key={k} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}

/** Error state: what failed, what Psyche did, one next step (§3.0). */
export function ErrorNotice({
  what,
  did = "Nothing was changed.",
  onRetry,
  className,
}: {
  what: string;
  did?: string;
  onRetry?: () => void;
  className?: string;
}): ReactElement {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-lg border border-gray-6 bg-gray-2 p-3 text-sm",
        className,
      )}
    >
      <CircleAlert className="size-4 shrink-0 text-danger-text" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-medium text-danger-text">{what}</span> {did}
      </p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Empty state: one sentence plus one action (§4.13). */
export function EmptyNotice({ text, action }: { text: string; action?: ReactNode }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-gray-6 p-4 text-sm">
      <p className="min-w-0 flex-1 text-muted-foreground">{text}</p>
      {action}
    </div>
  );
}

export function AdminHint({ show }: { show: boolean }): ReactElement | null {
  if (!show) return null;
  return (
    <p className="flex items-center gap-1.5 text-xs text-approval-text" role="status">
      <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
      Needs approval on this device. Change it from a device paired as admin.
    </p>
  );
}

// --- Fields ------------------------------------------------------------------------------------

export interface FieldOption<T extends string> {
  value: T;
  label: string;
  hint?: ReactNode;
  disabled?: boolean;
}

export function RadioField<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  inline = false,
  hideLabel = false,
  settingKey,
  children,
}: {
  label: string;
  description?: ReactNode;
  settingKey?: string;
  value: T;
  options: readonly FieldOption<T>[];
  onChange: (value: T) => void;
  inline?: boolean;
  hideLabel?: boolean;
  children?: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span
        id={`${id}-label`}
        className={cn("font-medium text-foreground", hideLabel && "sr-only")}
      >
        {label}
      </span>
      {description ? (
        <p id={`${id}-desc`} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      <RadioGroup
        aria-labelledby={`${id}-label`}
        {...(description ? { "aria-describedby": `${id}-desc` } : {})}
        value={value}
        onValueChange={(v) => onChange(v as T)}
        className={cn(inline ? "flex flex-wrap gap-x-4 gap-y-2" : "grid gap-2")}
      >
        {options.map((o) => (
          <div key={o.value} className="flex items-start gap-2">
            <RadioGroupItem
              value={o.value}
              id={`${id}-${o.value}`}
              className="mt-0.5"
              {...(o.disabled ? { disabled: true } : {})}
            />
            <Label
              htmlFor={`${id}-${o.value}`}
              className="flex-col items-start gap-0.5 font-normal"
            >
              <span>{o.label}</span>
              {o.hint ? (
                <span className="text-xs leading-4 text-muted-foreground">{o.hint}</span>
              ) : null}
            </Label>
          </div>
        ))}
      </RadioGroup>
      {settingKey ? <SettingHint settingKey={settingKey} /> : null}
      {children}
    </div>
  );
}

export function SwitchField({
  label,
  description,
  checked,
  onChange,
  disabled = false,
  settingKey,
  children,
}: {
  label: string;
  description?: ReactNode;
  settingKey?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <span id={`${id}-label`} className="font-medium text-foreground">
            {label}
          </span>
          {description ? (
            <p id={`${id}-desc`} className="text-xs text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        <Switch
          aria-labelledby={`${id}-label`}
          {...(description ? { "aria-describedby": `${id}-desc` } : {})}
          checked={checked}
          onCheckedChange={(v) => onChange(v)}
          disabled={disabled}
        />
      </div>
      {settingKey ? <SettingHint settingKey={settingKey} /> : null}
      {children}
    </div>
  );
}

export type Tone = "success" | "danger" | "approval" | "info" | "neutral" | "accent";

const TONE: Record<Tone, string> = {
  success: "border-success/40 text-success-text",
  danger: "border-danger/40 text-danger-text",
  approval: "border-approval-border text-approval-text",
  info: "border-gray-6 text-info-text",
  neutral: "border-gray-6 text-gray-11",
  accent: "border-accent-7 text-accent-11",
};

/** A status chip whose meaning is in its text, not only its color (§4.11). */
export function StatusChip({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Definition rows (`<dl>`) for small key / value summaries. */
export function Facts({
  items,
  className,
}: {
  items: readonly { term: string; value: ReactNode }[];
  className?: string;
}): ReactElement {
  return (
    <dl className={cn("grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1", className)}>
      {items.map((i) => (
        <div key={i.term} className="contents">
          <dt className="text-muted-foreground">{i.term}</dt>
          <dd className="min-w-0 break-words">{i.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Loading and error states common to every section body. */
export interface LoadProps {
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function LoadGate({
  label,
  loading = false,
  error = null,
  onRetry,
  rows,
  children,
}: LoadProps & { label: string; rows?: number; children?: ReactNode }): ReactElement {
  if (loading) return <SectionSkeleton label={label} {...(rows === undefined ? {} : { rows })} />;
  if (error !== null)
    return (
      <ErrorNotice
        what={`Psyche couldn't load ${label} (${error}).`}
        did="Nothing was changed."
        {...(onRetry ? { onRetry } : {})}
      />
    );
  return <>{children}</>;
}

/** A text setting that commits on blur or Return, not on every keystroke. */
export function TextSetting({
  label,
  description,
  value,
  onCommit,
  placeholder,
  maxLength,
  settingKey,
  children,
}: {
  label: string;
  description?: ReactNode;
  settingKey?: string;
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  children?: ReactNode;
}): ReactElement {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onCommit(next);
  };
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {description ? (
        <p id={`${id}-desc`} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      <Input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="max-w-sm"
        {...(description ? { "aria-describedby": `${id}-desc` } : {})}
        {...(placeholder === undefined ? {} : { placeholder })}
        {...(maxLength === undefined ? {} : { maxLength })}
      />
      {settingKey ? <SettingHint settingKey={settingKey} /> : null}
      {children}
    </div>
  );
}
