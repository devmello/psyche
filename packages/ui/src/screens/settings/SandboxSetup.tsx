import type { MethodResult, SandboxSetupBackend } from "@psyche/protocol";
import {
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Label } from "../../components/ui/label.tsx";
import { useCall, useGatewayQuery } from "../../data/index.ts";
import { t } from "../../i18n/core.ts";
import { SafeLink } from "../../links/SafeLink.tsx";
import { SettingsApprovalProvider } from "./SettingsApproval.tsx";
import { approvalIdOf, messageOf, SettingsApprovalContext, useSettingsForm } from "./shared.tsx";

/**
 * Guided sandbox setup. srt first (Anthropic's sandbox runtime on macOS's Seatbelt, no VM):
 * commands run on the Mac without reading Psyche's private data. Then, optional, a container
 * runtime for stronger isolation. The container steps are the owner's to run (a copyable command
 * or an official link). srt itself can be installed by the Gateway with Psyche's own Node into
 * Psyche's tools folder, but only from a click and confirm here (`sandbox.installSrt`, which
 * also asks for presence); nothing is installed otherwise. "Check again" only looks
 * (`sandbox.setup`); choosing srt's location saves `exec.srtPath`, which asks for presence.
 * Used from the add-a-connector flow and onboarding.
 */

const SRT_INSTALL = "npm install -g @anthropic-ai/sandbox-runtime";
const SRT_REPO = "https://github.com/anthropic-experimental/sandbox-runtime";
const SRT_SETTING = "exec.srtPath";
const APPLE_RELEASES = "https://github.com/apple/container/releases";
const DOCKER_DESKTOP = "https://www.docker.com/products/docker-desktop/";
const RESTART_GATEWAY = "launchctl kickstart -k gui/$(id -u)/com.psyche.gateway";

type Setup = MethodResult<"sandbox.setup">;
type Installer = NonNullable<Setup["installer"]>;
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

const linkClass = "text-callout underline underline-offset-2";

/** srt's location, saved as `exec.srtPath` (a security setting: confirmed with presence). */
function ChooseSrt({ initial, onSaved }: { initial: string; onSaved: () => void }) {
  const id = useId();
  const form = useSettingsForm();
  const [path, setPath] = useState(initial);
  const saved = form.values[SRT_SETTING];
  const savedRef = useRef(saved);
  // A saved value (after the presence approval, too) is what the next check finds.
  useEffect(() => {
    if (saved !== savedRef.current) {
      savedRef.current = saved;
      onSaved();
    }
  }, [saved, onSaved]);
  const trimmed = path.trim();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{t("settings.sandbox.srt.path")}</Label>
      <span className="flex gap-2">
        <Input
          id={id}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          // i18n-ignore: a file path, not words
          placeholder="/opt/homebrew/bin/srt"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 font-mono"
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={!trimmed.startsWith("/")}
          onClick={() => form.onChange(SRT_SETTING, trimmed)}
        >
          {t("settings.sandbox.srt.use")}
        </Button>
      </span>
      <p className="text-footnote text-label-tertiary">{t("settings.sandbox.srt.useHint")}</p>
      {form.writeError ? (
        <p role="alert" className="text-footnote text-danger-text">
          {form.writeError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Install srt" / "Reinstall" / "Update srt": a click, then a confirm that names the package,
 * the pinned version and where it goes. The Gateway installs it with its bundled Node and saves
 * `exec.srtPath`; presence is asked for like any security change.
 */
function InstallSrt({
  installer,
  label,
  onInstalled,
}: {
  installer: Installer;
  label: string;
  onInstalled: () => void;
}) {
  const call = useCall();
  const requestApproval = useContext(SettingsApprovalContext);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (approvalId?: string) => {
    await call("sandbox.installSrt", approvalId === undefined ? {} : { approvalId });
    onInstalled();
  };
  const go = () => {
    setBusy(true);
    setError(null);
    run().then(
      () => {
        setBusy(false);
        setConfirming(false);
      },
      (err: unknown) => {
        setBusy(false);
        const id = approvalIdOf(err);
        if (id !== null && requestApproval) {
          setConfirming(false);
          requestApproval({ key: SRT_SETTING, approvalId: id, retry: (aid) => run(aid) });
        } else {
          setError(t("settings.sandbox.srt.installFailed", { reason: messageOf(err) }));
        }
      },
    );
  };
  if (!confirming) {
    return (
      <span className="flex flex-col gap-1.5">
        <span>
          <Button type="button" size="sm" onClick={() => setConfirming(true)}>
            {label}
          </Button>
        </span>
        {error ? (
          <p role="alert" className="text-footnote text-danger-text">
            {error}
          </p>
        ) : null}
      </span>
    );
  }
  const vars = { package: installer.package, version: installer.version, dir: installer.dir };
  return (
    <section
      aria-label={t("settings.sandbox.srt.installConfirm.title", vars)}
      className="flex flex-col gap-2 rounded-md border border-separator px-3 py-2"
    >
      <p className="text-callout font-medium text-label-primary">
        {t("settings.sandbox.srt.installConfirm.title", vars)}
      </p>
      <p className="text-callout text-label-secondary">
        {t("settings.sandbox.srt.installConfirm.body", vars)}
      </p>
      <p className="break-all font-mono text-footnote text-label-secondary">
        {t("settings.sandbox.srt.installConfirm.where", vars)}
      </p>
      {error ? (
        <p role="alert" className="text-footnote text-danger-text">
          {error}
        </p>
      ) : null}
      <span className="flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={go}>
          {busy
            ? t("settings.sandbox.srt.installing")
            : t("settings.sandbox.srt.installConfirm.go")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="plain"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          {t("settings.sandbox.srt.installConfirm.cancel")}
        </Button>
      </span>
    </section>
  );
}

function SrtPart({ data, onSaved }: { data: Setup | undefined; onSaved: () => void }) {
  const [choosing, setChoosing] = useState(false);
  const srt = data?.srt;
  const installer = data?.installer;
  const readyAt = srt?.available ? srt.path : null;
  if (typeof readyAt === "string") {
    return (
      <>
        <p role="status" className="text-callout text-label-primary">
          <strong>{t("settings.sandbox.ready")}</strong>{" "}
          {t("settings.sandbox.srt.ready", { path: readyAt })}
        </p>
        {installer?.installedVersion ? (
          <p className="text-footnote text-label-tertiary">
            {t("settings.sandbox.srt.installed", { version: installer.installedVersion })}
          </p>
        ) : null}
        {installer?.updateAvailable ? (
          <>
            <p className="text-footnote text-label-secondary">
              {t("settings.sandbox.srt.updateAvailable", {
                version: installer.version,
                installed: installer.installedVersion ?? "",
              })}
            </p>
            <InstallSrt
              installer={installer}
              label={t("settings.sandbox.srt.updateButton")}
              onInstalled={onSaved}
            />
          </>
        ) : null}
      </>
    );
  }
  const fromEnv = srt?.source === "env";
  return (
    <>
      {srt?.path && srt.problem ? (
        <p role="alert" className="text-callout text-danger-text">
          {t("settings.sandbox.srt.broken", { path: srt.path, problem: srt.problem })}
        </p>
      ) : null}
      <p className="text-callout font-medium text-label-primary">
        {t("settings.sandbox.srt.missing.title")}
      </p>
      <p className="text-callout text-label-secondary">{t("settings.sandbox.srt.missing.body")}</p>
      {installer && !fromEnv ? (
        <InstallSrt
          installer={installer}
          label={
            srt?.path && srt.problem
              ? t("settings.sandbox.srt.reinstallButton")
              : t("settings.sandbox.srt.installButton")
          }
          onInstalled={onSaved}
        />
      ) : null}
      {installer && !fromEnv ? (
        <p className="text-footnote text-label-tertiary">{t("settings.sandbox.srt.installOr")}</p>
      ) : null}
      <ol className="flex flex-col gap-3">
        <Step n={1} title={t("settings.sandbox.srt.install")}>
          <CopyCommand command={SRT_INSTALL} />
          <SafeLink href={SRT_REPO} className={linkClass}>
            {t("settings.sandbox.srt.link")}
          </SafeLink>
        </Step>
        <Step n={2} title={t("settings.sandbox.srt.thenCheck")}>
          <span className="text-callout text-label-secondary">
            {t("settings.sandbox.srt.thenCheckBody")}
          </span>
        </Step>
      </ol>
      {fromEnv ? (
        <p className="text-footnote text-label-tertiary">{t("settings.sandbox.srt.fromEnv")}</p>
      ) : choosing ? (
        <ChooseSrt initial={srt?.source === "setting" ? (srt.path ?? "") : ""} onSaved={onSaved} />
      ) : (
        <span>
          <Button type="button" size="sm" variant="plain" onClick={() => setChoosing(true)}>
            {t("settings.sandbox.srt.choose")}
          </Button>
        </span>
      )}
    </>
  );
}

function ContainerPart({ containers }: { containers: Setup["containers"] }): ReactElement {
  const running = containers.backends.find((b) => b.running);
  const stopped = containers.backends.find((b) => b.supported && b.installed && !b.running);
  const recommended = containers.recommended;
  if (containers.restartNeeded && running) {
    return (
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
  }
  if (running) {
    return (
      <p className="text-callout text-label-primary">
        {t("settings.sandbox.containers.ready", { runtime: runtimeName(running.kind) })}
      </p>
    );
  }
  if (stopped) {
    return (
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
  }
  return (
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
            <SafeLink href={APPLE_RELEASES} className={linkClass}>
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
            <SafeLink href={DOCKER_DESKTOP} className={linkClass}>
              {t("settings.sandbox.step.desktopLink")}
            </SafeLink>
          </Step>
        </ol>
      )}
    </>
  );
}

export function SandboxSetup({
  onReady,
  onReadyChange,
  className,
}: {
  /** Called when srt becomes available, so command servers can run. */
  onReady?: (() => void) | undefined;
  /** Every answer's readiness, for a host that changes around it (onboarding's Skip). */
  onReadyChange?: ((ready: boolean) => void) | undefined;
  className?: string | undefined;
}): ReactElement {
  const q = useGatewayQuery("sandbox.setup", {});
  const data = q.data;
  const ready = data?.ready === true;
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

  return (
    <SettingsApprovalProvider>
      <div className={`flex flex-col gap-3 ${className ?? ""}`} data-testid="sandbox-setup">
        <p className="text-callout text-label-primary">{t("settings.sandbox.why")}</p>
        <p className="text-callout text-label-secondary">{t("settings.sandbox.whyHow")}</p>
        <p className="text-footnote text-label-tertiary">{t("settings.sandbox.privacy")}</p>
        {data === undefined && q.loading ? (
          <p className="text-callout text-label-secondary">{t("settings.sandbox.checking")}</p>
        ) : (
          <SrtPart data={data} onSaved={q.reload} />
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={q.reload}
            disabled={q.loading}
          >
            {t("settings.sandbox.checkAgain")}
          </Button>
          {onReady && ready ? (
            <Button type="button" size="sm" onClick={onReady}>
              {t("settings.sandbox.done")}
            </Button>
          ) : null}
        </div>
        {data ? (
          <details className="flex flex-col gap-3 rounded-md border border-separator px-3 py-2">
            <summary className="cursor-pointer text-callout font-medium text-label-primary">
              {t("settings.sandbox.containers.title")}
            </summary>
            <div className="mt-2 flex flex-col gap-3">
              <p className="text-callout text-label-secondary">
                {t("settings.sandbox.containers.body")}
              </p>
              <ContainerPart containers={data.containers} />
            </div>
          </details>
        ) : null}
      </div>
    </SettingsApprovalProvider>
  );
}
