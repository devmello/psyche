import { type ReactElement, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { tk } from "../../i18n/dynamic.ts";
import { describeError } from "../../i18n/errors.ts";
import {
  CAPABILITIES,
  type Capability,
  type CapabilityId,
  isAvailable,
} from "../onboarding/capabilities.ts";

/**
 * "What can you do?" (reachable from the sidebar and the empty chat): capability cards with
 * one-click example prompts and starter automations. Cards that need an account are listed
 * apart as "Connect to unlock", so what is shown first is what works now.
 */
export function CapabilitiesScreen({
  onUsePrompt,
  onCreateAutomation,
  onConnect,
  connectedTypes,
}: {
  /** Puts the prompt in the composer (or sends it) in the main chat. */
  onUsePrompt: (prompt: string) => void;
  /** Creates the card's starter automation; absent hides the button. */
  onCreateAutomation?: (id: CapabilityId, cron: string, name: string) => Promise<void>;
  onConnect?: () => void;
  /** Override for tests and stories; otherwise the Gateway's connected connectors. */
  connectedTypes?: ReadonlySet<string>;
}): ReactElement {
  const live = useGatewayQuery("connectors.list", {}, { enabled: connectedTypes === undefined });
  const connected =
    connectedTypes ??
    new Set(
      (live.data?.connectors ?? []).filter((c) => c.status === "connected").map((c) => c.type),
    );
  const ready = CAPABILITIES.filter((c) => isAvailable(c, connected));
  const locked = CAPABILITIES.filter((c) => !isAvailable(c, connected));
  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8"
      data-testid="capabilities"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-large-title text-label-primary">{t("capabilities.title")}</h1>
        <p className="text-reading text-label-secondary">{t("capabilities.lead")}</p>
      </header>
      <Group
        title={t("capabilities.available")}
        items={ready}
        ready
        {...{ onUsePrompt, onCreateAutomation }}
      />
      {locked.length > 0 ? (
        <Group title={t("capabilities.locked")} items={locked} ready={false} {...{ onUsePrompt }}>
          {onConnect ? (
            <Button type="button" variant="outline" onClick={onConnect}>
              {t("capabilities.connect")}
            </Button>
          ) : null}
        </Group>
      ) : null}
    </div>
  );
}

function Group({
  title,
  items,
  ready,
  onUsePrompt,
  onCreateAutomation,
  children,
}: {
  title: string;
  items: readonly Capability[];
  ready: boolean;
  onUsePrompt: (prompt: string) => void;
  onCreateAutomation?:
    | ((id: CapabilityId, cron: string, name: string) => Promise<void>)
    | undefined;
  children?: ReactElement | null;
}): ReactElement {
  return (
    <section className="flex flex-col gap-3" aria-label={title} data-ready={ready}>
      <h2 className="text-headline text-label-secondary">{title}</h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((c) => (
          <Card key={c.id} capability={c} ready={ready} {...{ onUsePrompt, onCreateAutomation }} />
        ))}
      </ul>
      {children}
    </section>
  );
}

function Card({
  capability: c,
  ready,
  onUsePrompt,
  onCreateAutomation,
}: {
  capability: Capability;
  ready: boolean;
  onUsePrompt: (prompt: string) => void;
  onCreateAutomation?:
    | ((id: CapabilityId, cron: string, name: string) => Promise<void>)
    | undefined;
}): ReactElement {
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoName = c.automation ? tk(`capabilities.${c.id}.auto`) : "";
  return (
    <li
      className="flex flex-col gap-2 rounded-lg bg-fill-quaternary p-4 data-[ready=false]:opacity-60"
      data-capability={c.id}
      data-ready={ready}
    >
      <p className="text-headline text-label-primary">{tk(`capabilities.${c.id}.title`)}</p>
      <p className="text-callout text-label-secondary">{tk(`capabilities.${c.id}.desc`)}</p>
      {ready ? (
        <div className="flex flex-col items-start gap-1">
          {c.prompts.map((n) => {
            const prompt = tk(`capabilities.${c.id}.prompt${n}`);
            return (
              <Button key={n} type="button" variant="plain" onClick={() => onUsePrompt(prompt)}>
                {t("capabilities.try", { prompt })}
              </Button>
            );
          })}
          {c.automation && onCreateAutomation ? (
            <Button
              type="button"
              variant="outline"
              disabled={added}
              onClick={() =>
                onCreateAutomation(c.id, (c.automation as { cron: string }).cron, autoName).then(
                  () => setAdded(true),
                  (err: unknown) =>
                    setError(t("capabilities.automationFailed", { reason: describeError(err) })),
                )
              }
            >
              {added
                ? t("capabilities.automationAdded", { name: autoName })
                : t("capabilities.addAutomation", { name: autoName })}
            </Button>
          ) : null}
          {error ? (
            <p role="alert" className="text-callout text-danger-text">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
