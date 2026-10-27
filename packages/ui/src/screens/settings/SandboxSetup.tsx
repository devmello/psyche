import type { SandboxSetupBackend } from "@psyche/protocol";
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button.tsx";
import { useGatewayQuery } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { SafeLink } from "../../links/SafeLink.tsx";

/**
 * Guided sandbox setup: what the sandbox is for, which runtime to get, and the steps, each one
 * run by the owner (a copyable command or an official download). Psyche installs and starts
 * nothing here; "Check again" only looks (`sandbox.setup`). Used from the add-a-connector flow
 * and onboarding.
 */

const APPLE_RELEASES = "https://github.com/apple/container/releases";
const DOCKER_DESKTOP = "https://www.docker.com/products/docker-desktop/";
const RESTART_GATEWAY = "launchctl kickstart -k gui/$(id -u)/com.psyche.gateway";

type Runtime = SandboxSetupBackend["kind"];
/** Catalogue ids are camelCase. */
const KEY: Record<Runtime, "appleContainer" | "docker" | "podman"> = {
  "apple-container": "appleContainer",
  docker: "docker",
  podman: "podman",
};
const runtimeName = (k: Runtime) => t(`settings.sandbox.runtime.${KEY[k]}`);

/** Starting an installed runtime, as a command the owner runs. */
const START_COMMAND: Record<Runtime, string> = {
  "apple-container": "container system start",
  docker: "colima start",
  podman: "podman machine start",
};

function CopyCommand({ command }: { command: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try {
      void navigator.clipboard?.writeText(command).then(
        () => setCopied(true),
        () => {},
      );
    } catch {
      // No clipboard here: the command is still on screen to select.
    }
  };
  return (
    <span className="flex items-center gap-2 rounded-md bg-fill-quaternary px-3 py-2">
      <code className="flex-1 break-all font-mono text-callout text-label-primary">{command}</code>
      <Button type="button" variant="ghost" size="sm" onClick={copy}>
        {copied ? t("settings.sandbox.copied") : t("settings.sandbox.copy")}
      </Button>
    </span>
  );
}

function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex flex-col gap-1.5">
      <span className="text-callout font-medium text-label-primary">
        {n}. {title}
      </span>
      {children}
    </li>
  );
}

export function SandboxSetup({
  onReady,
  onReadyChange,
  className,
}: {
  /** Called once a runtime is running and the Gateway uses it. */
  onReady?: (() => void) | undefined;
  /** Every answer's readiness, for a host that changes around it (onboarding's Skip). */
  onReadyChange?: ((ready: boolean) => void) | undefined;
  className?: string | undefined;
}): ReactElement {
  const q = useGatewayQuery("sandbox.setup", {});
  const data = q.data;
  const ready = data?.ready === true && !data.restartNeeded;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const changeRef = useRef(onReadyChange);
  changeRef.current = onReadyChange;
  // Only the change to ready returns the owner to where they were; ready on arrival waits for Done.
  const wasReady = useRef<boolean | null>(null);
  useEffect(() => {
    if (data === undefined) return;
    changeRef.current?.(ready);
    if (ready && wasReady.current === false) readyRef.current?.();
    wasReady.current = ready;
  }, [data, ready]);

  const backends = data?.backends ?? [];
  const running = backends.find((b) => b.running);
  const stopped = backends.find((b) => b.supported && b.installed && !b.running);
  const recommended: Runtime = data?.recommended ?? "apple-container";

  let body: ReactElement;
  if (data === undefined && q.loading) {
    body = <p className="text-callout text-label-secondary">{t("settings.sandbox.checking")}</p>;
  } else if (ready && running) {
    body = (
      <p role="status" className="text-callout text-label-primary">
        <strong>{t("settings.sandbox.ready")}</strong>{" "}
        {t("settings.sandbox.readyBody", { runtime: runtimeName(running.kind) })}
      </p>
    );
  } else if (data?.restartNeeded && running) {
    body = (
      <>
        <p className="text-callout font-medium text-label-primary">
          {t("settings.sandbox.restart.title", { runtime: runtimeName(running.kind) })}
        </p>
        <p className="text-callout text-label-secondary">
          {t("settings.sandbox.restart.body", { runtime: runtimeName(running.kind) })}
        </p>
        <ol className="flex flex-col gap-3">
          <Step n={1} title={t("settings.sandbox.restart.step")}>
            <CopyCommand command={RESTART_GATEWAY} />
          </Step>
        </ol>
      </>
    );
  } else if (stopped) {
    body = (
      <>
        <p className="text-callout font-medium text-label-primary">
          {t("settings.sandbox.stopped.title", { runtime: runtimeName(stopped.kind) })}
        </p>
        <p className="text-callout text-label-secondary">
          {t(`settings.sandbox.stopped.${KEY[stopped.kind]}`)}
        </p>
        <ol className="flex flex-col gap-3">
          <Step n={1} title={t("settings.sandbox.step.start")}>
            <CopyCommand command={START_COMMAND[stopped.kind]} />
          </Step>
        </ol>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-callout font-medium text-label-primary">
          {t("settings.sandbox.missing.title", { runtime: runtimeName(recommended) })}
        </p>
        <p className="text-callout text-label-secondary">
          {t(
            `settings.sandbox.missing.${recommended === "apple-container" ? "appleContainer" : "docker"}`,
          )}
        </p>
        {recommended === "apple-container" ? (
          <ol className="flex flex-col gap-3">
            <Step n={1} title={t("settings.sandbox.step.download")}>
              <SafeLink href={APPLE_RELEASES} className="text-callout underline underline-offset-2">
                {t("settings.sandbox.step.downloadLink")}
              </SafeLink>
            </Step>
            <Step n={2} title={t("settings.sandbox.step.start")}>
              <CopyCommand command={START_COMMAND["apple-container"]} />
            </Step>
          </ol>
        ) : (
          <ol className="flex flex-col gap-3">
            <Step n={1} title={t("settings.sandbox.step.install")}>
              <CopyCommand command="brew install colima docker" />
            </Step>
            <Step n={2} title={t("settings.sandbox.step.start")}>
              <CopyCommand command={START_COMMAND.docker} />
            </Step>
            <Step n={3} title={t("settings.sandbox.step.orDesktop")}>
              <SafeLink href={DOCKER_DESKTOP} className="text-callout underline underline-offset-2">
                {t("settings.sandbox.step.desktopLink")}
              </SafeLink>
            </Step>
          </ol>
        )}
      </>
    );
  }

  return (
    <div className={`flex flex-col gap-3 ${className ?? ""}`} data-testid="sandbox-setup">
      <p className="text-callout text-label-secondary">{t("settings.sandbox.why")}</p>
      <p className="text-footnote text-label-tertiary">{t("settings.sandbox.privacy")}</p>
      {body}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={q.reload} disabled={q.loading}>
          {t("settings.sandbox.checkAgain")}
        </Button>
        {onReady && ready ? (
          <Button type="button" size="sm" onClick={onReady}>
            {t("settings.sandbox.done")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
