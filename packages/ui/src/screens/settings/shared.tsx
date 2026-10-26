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
import { DelayedSkeletons } from "../../components/DelayedSkeleton.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.tsx";
import { Skeleton } from "../../components/ui/skeleton.tsx";
import { Switch } from "../../components/ui/switch.tsx";
import { useSettings } from "../../data/hooks.ts";
import { t } from "../../i18n/core.ts";
import { describeError } from "../../i18n/errors.ts";
import { cn } from "../../lib/utils.ts";
import { SegmentedRadio } from "./SegmentedRadio.tsx";
import { settingLabel } from "./setting-labels.ts";

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

/** What to show for a failure: the Gateway's sentence (`describeError`), else the value. */
export function messageOf(err: unknown): string {
  return err instanceof Error || typeof err === "string" ? describeError(err) : String(err);
}

/** `details.approvalId` of an `approval_required` error (security settings, security §10). */
export function approvalIdOf(err: unknown): string | null {
  if (!hasCode(err, "approval_required")) return null;
  const details = (err as { details?: unknown }).details;
  const id = (details as { approvalId?: unknown } | null | undefined)?.approvalId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** A security setting waiting for the owner's approval with presence. */
export interface PendingSettingApproval {
  key: string;
  approvalId: string;
  /** Writes the value again with the approval; resolves once the Gateway saved it. */
  retry: (approvalId: string) => Promise<unknown>;
}

/** Provided by the Settings screen (`SettingsApprovalProvider`); absent in isolated panels. */
export const SettingsApprovalContext = createContext<
  ((pending: PendingSettingApproval) => void) | null
>(null);

/**
 * `useSettings()` plus error handling for writes: an admin key refused with `forbidden` lands in
 * `needsApproval` (shown as "Needs approval on this device"); anything else in `writeError`.
 */
export function useSettingsForm() {
  const { settings, set, loading, error, reload } = useSettings();
  const requestApproval = useContext(SettingsApprovalContext);
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
          const approvalId = approvalIdOf(err);
          if (approvalId !== null) {
            // Security settings need fresh presence: the Gateway issued a device-only card.
            if (requestApproval) {
              requestApproval({ key, approvalId, retry: (id) => set(key, value, id) });
            } else {
              setWriteError(t("settings.shared.needsPresence", { label: settingLabel(key) }));
            }
          } else if (hasCode(err, "forbidden") && isAdminSettingKey(key)) {
            setNeedsApproval((prev) => new Set(prev).add(key));
          } else {
            setWriteError(
              t("settings.shared.saveFailed", { label: settingLabel(key), reason: messageOf(err) }),
            );
          }
        },
      );
    },
    [set, requestApproval],
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
      <header className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {/* The section title (text-title-1, redesign §5.8); Settings owns the page's h1. */}
          <h2 id={id} className="text-title-1 text-label-primary">
            {title}
          </h2>
          {description ? <p className="text-callout text-label-secondary">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <NeedsApprovalContext.Provider value={needsApproval}>
        {children}
      </NeedsApprovalContext.Provider>
    </section>
  );
}

/** Rows inside a grouped container: padded, 36 px minimum, hairlines inset to the text. */
export const GROUP_ROWS =
  "flex flex-col rounded-lg bg-surface-raised text-body text-label-primary shadow-elevation-1 [&>*]:relative [&>*]:min-h-9 [&>*]:px-3 [&>*]:py-2 [&>*+*]:before:absolute [&>*+*]:before:inset-x-3 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-separator";

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
  // A grouped inset list (redesign §5.8): the title-3 header above, the raised container with
  // 36 px rows separated by hairlines inset to the text, and the help text under it.
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex flex-wrap items-end gap-2 px-1">
        <h3 id={id} className="min-w-0 flex-1 text-title-3 text-label-primary">
          {title}
        </h3>
        {actions}
      </div>
      {children ? <div className={GROUP_ROWS}>{children}</div> : null}
      {description ? <p className="px-1 text-callout text-label-secondary">{description}</p> : null}
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
    <DelayedSkeletons
      label={t("settings.shared.loading", { label })}
      className="flex flex-col gap-3"
    >
      <Skeleton className="h-6 w-48" />
      {Array.from({ length: rows }, (_, i) => `row-${i}`).map((k) => (
        <Skeleton key={k} className="h-16 w-full rounded-lg" />
      ))}
    </DelayedSkeletons>
  );
}

/** Error state: what failed, what Psyche did, one next step (§3.0). */
export function ErrorNotice({
  what,
  did = t("settings.shared.nothingChanged"),
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
      // An inline row on a raised surface; danger colours only the icon (redesign §5.10).
      className={cn(
        "flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised p-3 shadow-elevation-1",
        className,
      )}
    >
      <CircleAlert className="size-4 shrink-0 text-danger" aria-hidden="true" />
      <p className="flex min-w-0 flex-1 flex-col">
        <span className="text-headline text-label-primary">{what}</span>
        <span className="text-body text-label-secondary">{did}</span>
      </p>
      {onRetry ? (
        <Button type="button" variant="plain" size="sm" onClick={onRetry}>
          {t("settings.shared.tryAgain")}
        </Button>
      ) : null}
    </div>
  );
}

/** Empty state: one sentence plus one action (§4.13). */
export function EmptyNotice({ text, action }: { text: string; action?: ReactNode }): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg bg-surface-raised px-3 py-3 shadow-elevation-1">
      <p className="min-w-0 flex-1 text-body text-label-secondary">{text}</p>
      {action}
    </div>
  );
}

export function AdminHint({ show }: { show: boolean }): ReactElement | null {
  if (!show) return null;
  return (
    <p className="flex items-center gap-1.5 text-callout text-approval-text" role="status">
      <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />
      {t("settings.shared.needsAdmin")}
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
  grouped = false,
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
  /**
   * A grouped inset list (redesign-2026 §5.8): one 36 px row per option, label and hint leading,
   * the radio trailing, hairlines inset to the text.
   */
  grouped?: boolean;
  children?: ReactNode;
}): ReactElement {
  const id = useId();
  if (grouped) {
    return (
      <div className="flex flex-col gap-2">
        <span
          id={`${id}-label`}
          className={cn("px-1 text-title-3 text-label-primary", hideLabel && "sr-only")}
        >
          {label}
        </span>
        <RadioGroup
          aria-labelledby={`${id}-label`}
          {...(description ? { "aria-describedby": `${id}-desc` } : {})}
          value={value}
          onValueChange={(v) => onChange(v as T)}
          className="flex flex-col gap-0 rounded-lg bg-surface-raised shadow-elevation-1"
        >
          {options.map((o) => (
            <Label
              key={o.value}
              htmlFor={`${id}-${o.value}`}
              className="relative flex min-h-9 cursor-default items-center gap-3 px-3 py-2 font-normal before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden has-disabled:opacity-50"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body text-label-primary">{o.label}</span>
                {o.hint ? (
                  <span className="text-callout text-label-secondary">{o.hint}</span>
                ) : null}
              </span>
              <RadioGroupItem
                value={o.value}
                id={`${id}-${o.value}`}
                {...(o.disabled ? { disabled: true } : {})}
              />
            </Label>
          ))}
        </RadioGroup>
        {description ? (
          <p id={`${id}-desc`} className="px-1 text-callout text-label-secondary">
            {description}
          </p>
        ) : null}
        {settingKey ? <SettingHint settingKey={settingKey} /> : null}
        {children}
      </div>
    );
  }
  // A short inline choice (Theme: Auto / Light / Dark) is a trailing segmented control (§5.8);
  // the selected option's hint reads under the row.
  if (inline && options.length <= 4 && options.every((o) => !o.disabled)) {
    const selectedHint = options.find((o) => o.value === value)?.hint;
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <span
              id={`${id}-label`}
              className={cn("text-body text-label-primary", hideLabel && "sr-only")}
            >
              {label}
            </span>
            {description ? (
              <p id={`${id}-desc`} className="text-callout text-label-secondary">
                {description}
              </p>
            ) : null}
          </div>
          <SegmentedRadio label={label} options={options} value={value} onChange={onChange} />
        </div>
        {selectedHint ? (
          <p className="text-callout text-label-secondary" aria-live="polite">
            {selectedHint}
          </p>
        ) : null}
        {settingKey ? <SettingHint settingKey={settingKey} /> : null}
        {children}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span
        id={`${id}-label`}
        className={cn("text-body text-label-primary", hideLabel && "sr-only")}
      >
        {label}
      </span>
      {description ? (
        <p id={`${id}-desc`} className="text-callout text-label-secondary">
          {description}
        </p>
      ) : null}
      <RadioGroup
        aria-labelledby={`${id}-label`}
        {...(description ? { "aria-describedby": `${id}-desc` } : {})}
        value={value}
        onValueChange={(v) => onChange(v as T)}
        className={cn(inline ? "flex flex-wrap gap-x-4 gap-y-2" : "flex flex-col gap-0")}
      >
        {options.map((o) =>
          inline ? (
            <div key={o.value} className="flex items-start gap-2">
              <RadioGroupItem
                value={o.value}
                id={`${id}-${o.value}`}
                className="mt-0.5"
                {...(o.disabled ? { disabled: true } : {})}
              />
              <Label
                htmlFor={`${id}-${o.value}`}
                className="flex-col items-start gap-0.5 text-body font-normal text-label-primary"
              >
                <span>{o.label}</span>
                {o.hint ? (
                  <span className="text-callout text-label-secondary">{o.hint}</span>
                ) : null}
              </Label>
            </div>
          ) : (
            // One row per option, the radio trailing, hairlines between (System Settings).
            <Label
              key={o.value}
              htmlFor={`${id}-${o.value}`}
              className="relative flex min-h-9 cursor-default items-center gap-3 py-1.5 font-normal before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-separator first:before:hidden has-disabled:opacity-50"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body text-label-primary">{o.label}</span>
                {o.hint ? (
                  <span className="text-callout text-label-secondary">{o.hint}</span>
                ) : null}
              </span>
              <RadioGroupItem
                value={o.value}
                id={`${id}-${o.value}`}
                {...(o.disabled ? { disabled: true } : {})}
              />
            </Label>
          ),
        )}
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
      <div className="flex min-h-5 items-center gap-3">
        <div className="min-w-0 flex-1">
          <span id={`${id}-label`} className="text-body text-label-primary">
            {label}
          </span>
          {description ? (
            <p id={`${id}-desc`} className="text-callout text-label-secondary">
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
  info: "border-separator-strong text-info-text",
  neutral: "border-separator-strong text-label-secondary",
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
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-caption whitespace-nowrap",
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
          <dt className="text-label-secondary">{i.term}</dt>
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
        what={t("settings.shared.loadFailed", { label, reason: error })}
        did={t("settings.shared.nothingChanged")}
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
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Label htmlFor={id} className="text-body font-normal text-label-primary">
            {label}
          </Label>
          {description ? (
            <p id={`${id}-desc`} className="text-callout text-label-secondary">
              {description}
            </p>
          ) : null}
        </div>
        <Input
          id={id}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          className="h-7 w-full sm:w-56"
          {...(description ? { "aria-describedby": `${id}-desc` } : {})}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(maxLength === undefined ? {} : { maxLength })}
        />
      </div>
      {settingKey ? <SettingHint settingKey={settingKey} /> : null}
      {children}
    </div>
  );
}
