import type { WidgetAction } from "@psyche/protocol";
import { Check } from "lucide-react";
import { type FormEvent, type ReactElement, useId, useState } from "react";
import { isSafeLink } from "../blocks/Markdown.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { Textarea } from "../components/ui/textarea.tsx";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { SafeLink } from "../links/SafeLink.tsx";
import { type ActionRunner, useWidgetAction } from "./actions.ts";

/**
 * Buttons, choices, forms and actionable list rows (generative-ui-2026 §6). Every control is a
 * native, labelled element drawn by the host in the outline style: never the filled primary of an
 * approval card, never amber. The spec supplies the words and the action; this file decides what a
 * click does (see `actions.ts`). Controls whose action needs a later phase are not drawn.
 */

type N = Record<string, unknown>;
const str = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
const arr = (v: unknown): N[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as N[]) : [];

/** Actions this build can run; `tool` arrives with P7. */
export function runnable(action: unknown): action is WidgetAction {
  if (!action || typeof action !== "object") return false;
  const a = action as { kind?: unknown };
  return a.kind === "reply" || a.kind === "answer" || a.kind === "open";
}

function Status({ runner }: { runner: ActionRunner }): ReactElement | null {
  return (
    <>
      <span className="sr-only" role="status">
        {runner.state === "sent" ? t("widgets.action.sent") : ""}
      </span>
      {runner.error !== null ? (
        <span className="block text-callout text-danger-text" role="alert">
          {runner.error}
        </span>
      ) : null}
    </>
  );
}

/** An `open {url}` is a link, so it goes through the owner's link policy like any other. */
function isUrlOpen(
  a: WidgetAction,
): a is Extract<WidgetAction, { kind: "open" }> & { url: string } {
  return a.kind === "open" && typeof a.url === "string";
}

export function ButtonNode({ n }: { n: N }): ReactElement | null {
  const runner = useWidgetAction();
  const action = n.action;
  if (!runnable(action)) return null;
  const label = str(n.label);
  if (isUrlOpen(action)) {
    return isSafeLink(action.url) ? (
      <SafeLink href={action.url}>{label}</SafeLink>
    ) : (
      <span>{label}</span>
    );
  }
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={runner.state !== "idle"}
        onClick={() => void runner.run(action)}
      >
        {runner.state === "sent" ? <Check aria-hidden="true" /> : null}
        {label}
      </Button>
      <Status runner={runner} />
    </span>
  );
}

/** A list row whose title is a control when the row carries an action. */
export function ListRowAction({ item }: { item: N }): ReactElement {
  const runner = useWidgetAction();
  const action = item.action;
  if (!runnable(action)) return <span className="min-w-0">{str(item.title)}</span>;
  if (isUrlOpen(action)) {
    return isSafeLink(action.url) ? (
      <SafeLink href={action.url}>{str(item.title)}</SafeLink>
    ) : (
      <span>{str(item.title)}</span>
    );
  }
  return (
    <span className="min-w-0">
      <button
        type="button"
        className="rounded-sm text-start underline-offset-2 hover:underline focus-visible:outline-2 disabled:opacity-60"
        disabled={runner.state !== "idle"}
        onClick={() => void runner.run(action)}
      >
        {str(item.title)}
      </button>
      <Status runner={runner} />
    </span>
  );
}

export function ChoicesNode({ n }: { n: N }): ReactElement | null {
  const runner = useWidgetAction();
  const base = useId();
  const options = arr(n.options);
  const multi = n.mode === "multi";
  const [picked, setPicked] = useState<string[]>([]);
  const action = n.action;
  // `ask: true` (a real InputRequest the Gateway creates) is a later phase.
  if (!runnable(action) || n.ask === true || isUrlOpen(action)) return null;
  const labels = picked.map((id) => str(options.find((o) => str(o.id) === id)?.label));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (picked.length === 0) return;
    if (action.kind === "reply") {
      const text = [action.text, labels.join(", ")].filter(Boolean).join(": ");
      void runner.run(action, text);
    } else if (action.kind === "answer") {
      void runner.run({ ...action, value: multi ? labels : (labels[0] as string) });
    } else void runner.run(action);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5" aria-label={str(n.label)}>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-0.5 text-callout text-label-secondary">{str(n.label)}</legend>
        {options.map((o) => {
          const id = str(o.id);
          const checked = picked.includes(id);
          return (
            <label key={id} className="inline-flex items-center gap-2" htmlFor={`${base}-${id}`}>
              <input
                id={`${base}-${id}`}
                type={multi ? "checkbox" : "radio"}
                name={base}
                checked={checked}
                onChange={() =>
                  setPicked((p) =>
                    multi ? (checked ? p.filter((x) => x !== id) : [...p, id]) : [id],
                  )
                }
              />
              {str(o.label)}
            </label>
          );
        })}
      </fieldset>
      <span>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={picked.length === 0 || runner.state !== "idle"}
        >
          {t("widgets.action.send")}
        </Button>
      </span>
      <Status runner={runner} />
    </form>
  );
}

type Values = Record<string, string | boolean>;

export function FormNode({ n }: { n: N }): ReactElement | null {
  const runner = useWidgetAction();
  const base = useId();
  const fields = arr(n.fields);
  const submitSpec = (n.submit ?? {}) as N;
  const [values, setValues] = useState<Values>({});
  // Only "reply" forms can run for now; "tool" forms arrive with P7.
  if (submitSpec.as !== "reply") return null;
  const set = (id: string, v: string | boolean) => setValues((p) => ({ ...p, [id]: v }));
  const missing = fields.some(
    (f) => f.required === true && f.type !== "toggle" && !String(values[str(f.id)] ?? "").trim(),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (missing) return;
    // The template is the spec's words; the values are what the owner typed. Both are shown in
    // the transcript as the message, so nothing is sent that the owner cannot read afterwards.
    const lines = fields.flatMap((f) => {
      const v = values[str(f.id)];
      if (v === undefined || v === "") return [];
      const shown =
        typeof v === "boolean" ? (v ? t("widgets.form.toggleOn") : t("widgets.form.toggleOff")) : v;
      return [`${str(f.label)}: ${shown}`];
    });
    const text = [str(submitSpec.template), ...lines].filter(Boolean).join("\n");
    if (text.trim() === "") return;
    void runner.run({ kind: "reply", text }, text);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-label={str(n.label)}>
      {fields.map((f) => {
        const id = `${base}-${str(f.id)}`;
        const label =
          f.required === true ? t("widgets.form.required", { label: str(f.label) }) : str(f.label);
        const value = values[str(f.id)];
        const common = {
          id,
          required: f.required === true,
          placeholder: str(f.placeholder) || undefined,
        };
        return (
          <div
            key={str(f.id)}
            className={cn(
              "flex flex-col gap-0.5",
              f.type === "toggle" && "flex-row items-center gap-2",
            )}
          >
            <label htmlFor={id} className="text-callout text-label-secondary">
              {label}
            </label>
            {f.type === "textarea" ? (
              <Textarea
                {...common}
                rows={3}
                value={String(value ?? "")}
                onChange={(e) => set(str(f.id), e.target.value)}
              />
            ) : f.type === "select" ? (
              <NativeSelect
                id={id}
                required={common.required}
                value={String(value ?? "")}
                onChange={(e) => set(str(f.id), e.target.value)}
              >
                <option value="">{t("widgets.form.choose")}</option>
                {arr(f.options).map((o) => (
                  <option key={str(o.id)} value={str(o.label)}>
                    {str(o.label)}
                  </option>
                ))}
              </NativeSelect>
            ) : f.type === "toggle" ? (
              <input
                id={id}
                type="checkbox"
                checked={value === true}
                onChange={(e) => set(str(f.id), e.target.checked)}
              />
            ) : (
              <Input
                {...common}
                type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"}
                value={String(value ?? "")}
                onChange={(e) => set(str(f.id), e.target.value)}
              />
            )}
          </div>
        );
      })}
      <span>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={missing || runner.state !== "idle"}
        >
          {str(submitSpec.label)}
        </Button>
      </span>
      <Status runner={runner} />
    </form>
  );
}
