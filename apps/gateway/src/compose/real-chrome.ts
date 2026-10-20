import {
  type BrowserDriverEx,
  type LibraryWriter,
  launchRealChrome,
  type OriginPolicy,
  PlaywrightDriver,
  type RealChrome,
  type RealChromeDeps,
  type RealChromeOptions,
  type RoutingDriver,
} from "@psyche/browser";
import type { DriverSession, Notification, PermissionBroker } from "@psyche/protocol";
import type { ComposeServices } from "./services.ts";

/**
 * Real-Chrome mode in the Gateway (feature I13; ADR-007; security §6). Off unless the owner
 * enables it. When a task gets the owner's per-session consent (`browser.use_real_chrome`, a
 * device-only `policy_change` approval), this launches the Psyche Chrome profile, attaches a
 * Playwright `connectOverCDP` driver to the routing driver and opens the task's session there,
 * sharing the task's origin policy. While attached:
 *
 * - the DevTools port is one of Psyche's own (`ownPorts`), so the localhost rule refuses it;
 * - the owner sees an unresolved "Psyche is driving your Chrome" notification and the window
 *   title says so;
 * - `status()` reports the port and PID for `psyche security audit`.
 *
 * Chrome closes (and the port with it) when the last task releases it, after `idleMs` without
 * use, when it exits on its own, or when the Gateway stops.
 */
export interface RealChromeSetup {
  /** Off by default; `PSYCHE_REAL_CHROME=1`. */
  enabled?: boolean;
  profile?: string;
  /** Close Chrome after this long without a browser call on its tabs (default 15 min). */
  idleMs?: number;
  /** Tests: a fake Chrome and a driver for it. */
  launch?: (options: RealChromeOptions) => Promise<RealChrome>;
  connect?: (endpoint: string) => BrowserDriverEx & { dispose?(): unknown };
  launchOptions?: RealChromeOptions;
}

export interface RealChromeStatus {
  attached: boolean;
  port?: number;
  pid?: number;
  since?: string;
  sessions: number;
  userDataDir?: string;
}

export interface RealChromeMode extends RealChromeDeps {
  status(): RealChromeStatus;
  /** Live real-Chrome sessions, for the client's `browser.tabs`. */
  sessions(): DriverSession[];
  /** A browser call touched one of its tabs (keeps it from idling out). */
  touch(): void;
  stop(): Promise<void>;
}

export function createRealChromeMode(o: {
  services: ComposeServices;
  router: RoutingDriver;
  setup: RealChromeSetup;
  library: LibraryWriter;
  broker: PermissionBroker;
  redact?: (text: string) => string;
  /** The task's (or thread's) session key, shared with the web session. */
  keyFor(callId: string): string;
  /** The task's shared origin policy. */
  policyFor(key: string): OriginPolicy;
  /** The call's task id; default from the running call's context. */
  taskIdFor?(callId: string): string | undefined;
}): RealChromeMode {
  const { services, router, setup } = o;
  const log = services.logger;
  let chrome: RealChrome | undefined;
  let driver: (BrowserDriverEx & { dispose?(): unknown }) | undefined;
  let unregisterPort: (() => void) | undefined;
  let note: Notification | undefined;
  let starting: Promise<void> | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const sessions = new Map<string, DriverSession>();
  const idleMs = setup.idleMs ?? 15 * 60_000;

  const armIdle = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (chrome === undefined) return;
    idleTimer = setTimeout(() => void teardown("idle"), idleMs);
    idleTimer.unref?.();
  };

  const teardown = async (reason: string): Promise<void> => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (chrome === undefined && driver === undefined) return;
    router.detach("real_chrome");
    sessions.clear();
    const d = driver;
    const c = chrome;
    driver = undefined;
    chrome = undefined;
    await Promise.resolve(d?.dispose?.()).catch(() => undefined);
    await c?.close().catch(() => undefined);
    // Only now: the port stays refused until the process is gone.
    unregisterPort?.();
    unregisterPort = undefined;
    if (note !== undefined) await services.notifier.resolve(note.id).catch(() => undefined);
    note = undefined;
    log?.log("info", "real Chrome detached", { reason });
  };

  const ensure = async (): Promise<void> => {
    if (chrome?.running === true && driver !== undefined) return;
    starting ??= (async () => {
      const launched = await (setup.launch ?? launchRealChrome)({
        ...(setup.launchOptions ?? {}),
        ...(setup.profile === undefined ? {} : { profile: setup.profile }),
        psycheHome: services.home,
      });
      chrome = launched;
      unregisterPort = services.ownPorts.add(launched.port, "real-Chrome CDP");
      try {
        driver =
          setup.connect?.(launched.endpoint) ??
          new PlaywrightDriver({
            mode: "connect",
            cdpEndpoint: launched.endpoint,
            library: o.library,
            broker: o.broker,
            ...(o.redact === undefined ? {} : { redact: o.redact }),
          });
        router.attach("real_chrome", driver);
      } catch (err) {
        await teardown("attach failed");
        throw err;
      }
      launched.onExit(() => void teardown("chrome exited"));
      note = await services.notifier
        .notify({
          kind: "system",
          title: "Psyche is driving your Chrome",
          body: "A task is using the Psyche Chrome profile, where you are signed in. Its window title says “Psyche is driving this window”. It closes when the task is done; you can also quit Chrome.",
          route: "/browser",
          dedupeKey: "browser-real-chrome",
        })
        .catch(() => undefined);
      log?.log("info", "real Chrome attached", { port: launched.port, pid: launched.pid });
    })().finally(() => {
      starting = undefined;
    });
    await starting;
  };

  return {
    attached(callId) {
      return sessions.get(o.keyFor(callId))?.id;
    },
    sessions: () => [...sessions.values()],
    async attach(callId) {
      if (setup.enabled !== true) throw new Error("real-Chrome mode is off");
      const key = o.keyFor(callId);
      const existing = sessions.get(key);
      if (existing !== undefined) return existing.id;
      await ensure();
      const taskId = o.taskIdFor?.(callId) ?? services.calls.context(callId).taskId;
      const session = await router.openSessionOn("real_chrome", {
        ...(taskId === undefined ? {} : { taskId }),
        partition: "profile",
        // Origin sets are unchanged: the same policy object as the task's web session.
        policy: o.policyFor(key),
      });
      sessions.set(key, session);
      armIdle();
      return session.id;
    },
    async detach(callId) {
      const key = o.keyFor(callId);
      const session = sessions.get(key);
      if (session === undefined) return false;
      sessions.delete(key);
      await router.closeSession(session.id).catch(() => undefined);
      if (sessions.size === 0) await teardown("released");
      return true;
    },
    owns(tabId) {
      return router.ownerOf(tabId) === "real_chrome";
    },
    touch: armIdle,
    status() {
      return chrome === undefined
        ? { attached: false, sessions: 0 }
        : {
            attached: true,
            port: chrome.port,
            pid: chrome.pid,
            since: new Date(chrome.startedAt).toISOString(),
            sessions: sessions.size,
            userDataDir: chrome.userDataDir,
          };
    },
    stop: () => teardown("gateway stopping"),
  };
}
