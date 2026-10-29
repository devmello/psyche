import type { EverythingExclusion } from "@psyche/protocol";
import { type ReactElement, useState } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { NativeSelect } from "../components/ui/native-select.tsx";
import { t } from "../i18n/core.ts";
import { Group } from "../screens/settings/shared.tsx";

/**
 * Per-contact exclusion (docs/design/everything-memory-2026.md §10.1): no text of an excluded
 * address, number or domain is read and nothing is learned about them. "Exclude and forget" also
 * deletes what was learned, after showing how much that is.
 */

type Kind = "email" | "phone" | "domain";

export interface ExclusionsPanelProps {
  entries: readonly EverythingExclusion[];
  busy?: boolean;
  /** `dryRun` returns the counts a forget would remove without deleting. */
  onAdd: (input: {
    kind: Kind;
    value: string;
    mode: "exclude" | "forget";
    dryRun?: boolean;
  }) => Promise<{ facts: number; citations: number } | undefined>;
  onRemove: (entry: EverythingExclusion) => void;
}

export function ExclusionsPanel({
  entries,
  busy = false,
  onAdd,
  onRemove,
}: ExclusionsPanelProps): ReactElement {
  const [kind, setKind] = useState<Kind>("email");
  const [value, setValue] = useState("");
  const [forget, setForget] = useState<{ facts: number; citations: number } | null>(null);
  const clean = value.trim();
  const reset = () => {
    setValue("");
    setForget(null);
  };
  return (
    <Group title={t("everything.exclusions.title")}>
      {entries.length === 0 ? (
        <p className="px-3 text-callout text-label-secondary">{t("everything.exclusions.empty")}</p>
      ) : (
        <ul className="overflow-hidden rounded-lg bg-fill-quaternary">
          {entries.map((e) => (
            <li
              key={e.id}
              data-testid="exclusion-row"
              className="relative flex items-center justify-between gap-2 px-3 py-1.5 before:absolute before:inset-x-3 before:top-0 before:h-px before:bg-separator first:before:hidden"
            >
              <span className="min-w-0 flex-1 truncate">
                {e.hint ?? e.kind}{" "}
                <span className="text-callout text-label-secondary">
                  {t(`everything.exclusions.mode.${e.mode}`)}
                </span>
              </span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRemove(e)}>
                {t("everything.exclusions.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2 px-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (clean === "") return;
          void onAdd({ kind, value: clean, mode: "exclude" }).then(reset);
        }}
      >
        <NativeSelect
          aria-label={t("everything.exclusions.kind")}
          value={kind}
          onChange={(ev) => setKind(ev.target.value as Kind)}
          className="h-7 w-28"
        >
          <option value="email">email</option>
          <option value="phone">phone</option>
          <option value="domain">domain</option>
        </NativeSelect>
        <Input
          aria-label={t("everything.exclusions.value")}
          placeholder={t("everything.exclusions.value")}
          value={value}
          maxLength={320}
          onChange={(ev) => {
            setValue(ev.target.value);
            setForget(null);
          }}
          className="h-7 min-w-0 flex-1"
        />
        <Button type="submit" size="sm" disabled={busy || clean === ""}>
          {t("everything.exclusions.exclude")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={busy || clean === ""}
          onClick={() => {
            if (forget === null) {
              void onAdd({ kind, value: clean, mode: "forget", dryRun: true }).then((c) =>
                setForget(c ?? { facts: 0, citations: 0 }),
              );
            } else {
              void onAdd({ kind, value: clean, mode: "forget" }).then(reset);
            }
          }}
        >
          {t("everything.exclusions.excludeForget")}
        </Button>
      </form>
      {forget !== null ? (
        <p
          role="status"
          data-testid="forget-confirm"
          className="px-3 text-callout text-approval-text"
        >
          {t("everything.exclusions.confirmForget", forget)}
        </p>
      ) : null}
    </Group>
  );
}
