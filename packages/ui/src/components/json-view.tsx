import { Check, ChevronRight, Copy, KeyRound, Lock } from "lucide-react";
import { type ReactElement, useState } from "react";
import { t } from "../i18n/core.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";

/**
 * A step's input or output in the run trace's inspector (docs/design/run-trace-2026.md §3.3):
 * collapsible objects and arrays, monospaced, with the Gateway's redaction tokens drawn as chips
 * so a redaction never reads as an empty value. `‹redacted›` is a secret string; `‹vault: name›`
 * a vault reference. Copy copies the redacted JSON (the values never left the vault).
 */

const REDACTED = /^‹redacted›$/;
const VAULT = /^‹vault: (.+)›$/;

/** Whether a string is one of the Gateway's redaction tokens. */
export function redactionToken(
  value: string,
): { kind: "redacted" } | { kind: "vault"; name: string } | null {
  if (REDACTED.test(value)) return { kind: "redacted" };
  const vault = VAULT.exec(value);
  return vault ? { kind: "vault", name: vault[1] as string } : null;
}

function Token({ value }: { value: string }): ReactElement {
  const token = redactionToken(value);
  if (!token) return <span className="text-success-text break-all">{JSON.stringify(value)}</span>;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-xs bg-fill-tertiary px-1 align-baseline font-sans text-caption text-label-secondary"
      data-redaction={token.kind}
    >
      {token.kind === "vault" ? (
        <KeyRound aria-hidden="true" className="size-3" />
      ) : (
        <Lock aria-hidden="true" className="size-3" />
      )}
      {token.kind === "vault"
        ? t("design.json.vault", { name: token.name })
        : t("design.json.redacted")}
    </span>
  );
}

function Scalar({ value }: { value: unknown }): ReactElement {
  if (typeof value === "string") return <Token value={value} />;
  if (value === null) return <span className="text-label-tertiary">null</span>;
  if (typeof value === "number" || typeof value === "boolean")
    return <span className="text-accent-11">{String(value)}</span>;
  return <span className="text-label-tertiary">{String(value)}</span>;
}

function Node({
  name,
  value,
  depth,
  openDepth,
}: {
  name?: string;
  value: unknown;
  depth: number;
  openDepth: number;
}): ReactElement {
  const isArray = Array.isArray(value);
  const isObject = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < openDepth);
  const key = name === undefined ? null : <span className="text-label-secondary">{name}: </span>;
  if (!isObject)
    return (
      <div className="ps-4">
        {key}
        <Scalar value={value} />
      </div>
    );
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const summary = isArray
    ? t("design.json.items", { n: entries.length })
    : t("design.json.keys", { n: entries.length });
  const label = name ?? (isArray ? "[]" : "{}");
  return (
    <div className={depth > 0 ? "ps-4" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="-ms-4 inline-flex items-center gap-0.5 rounded-xs text-start outline-none hover:bg-fill-quaternary focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={
          open ? t("design.json.collapse", { key: label }) : t("design.json.expand", { key: label })
        }
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3.5 text-label-tertiary transition-transform", open && "rotate-90")}
        />
        {key}
        <span className="text-label-tertiary">
          {isArray ? "[" : "{"}
          {open ? "" : ` ${summary} ${isArray ? "]" : "}"}`}
        </span>
      </button>
      {open ? (
        <>
          {entries.map(([k, v]) => (
            <Node
              key={k}
              name={isArray ? undefined : k}
              value={v}
              depth={depth + 1}
              openDepth={openDepth}
            />
          ))}
          <div className="text-label-tertiary">{isArray ? "]" : "}"}</div>
        </>
      ) : null}
    </div>
  );
}

export interface JsonViewProps {
  value: unknown;
  /** Levels open on first render (default 2). */
  openDepth?: number;
  /** "Showing 64 KB of 1.2 MB" when the Gateway truncated the payload. */
  truncated?: { shown: string; total: string };
  className?: string;
}

export function JsonView({
  value,
  openDepth = 2,
  truncated,
  className,
}: JsonViewProps): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(JSON.stringify(value, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      className={cn("relative rounded-md bg-fill-quaternary p-3 font-mono text-callout", className)}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={copy}
        className="absolute end-1 top-1 font-sans"
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {copied ? t("design.json.copied") : t("design.json.copy")}
      </Button>
      <div className="overflow-x-auto pe-16">
        <Node value={value} depth={0} openDepth={openDepth} />
      </div>
      {truncated ? (
        <p className="mt-2 font-sans text-caption text-label-tertiary">
          {t("design.json.truncated", truncated)}
        </p>
      ) : null}
    </div>
  );
}
