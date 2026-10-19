import { join } from "node:path";
import {
  type BridgeClient,
  BridgeServer,
  type BrowserDriverEx,
  CdpBridgeDriver,
  FileRecordingSink,
  FsQuarantineWriter,
  type LibraryWriter,
  type OriginPolicyOptions,
  type PartitionMode,
  registerBrowserTools,
} from "@psyche/browser";
import {
  type CredentialBroker,
  type DriverSession,
  type MethodParams,
  PsycheError,
  type RefBox,
  type ToolRegistration,
  type ToolRegistry,
} from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";
import type { Gateway } from "../server.ts";
import type { ComposedPart, ComposeServices } from "./services.ts";

/**
 * The agent browser (INT-2, architecture §8): the Gateway listens on the bridge socket, the
 * desktop connects as the bridge client (S11), and each authenticated connection gets a
 * `CdpBridgeDriver` (S08). The `browser.*` tools are registered once and use whichever desktop
 * is connected; without one they fail `unavailable`. Each Task (or thread, for chat turns) has
 * its own browser session, origin policy and, when enabled, a screencast recording under
 * `$PSYCHE_HOME/library/recordings/<task>/`.
 */
export interface BrowserSetup {
  /** Default `$PSYCHE_HOME/run/browser-bridge.sock`; `false` skips the socket (tests attach). */
  socketPath?: string | false;
  /** Download quarantine; `FsQuarantineWriter` until the Library owner ships one (S08 request). */
  library?: LibraryWriter;
  credentials?: CredentialBroker;
  /** Opt-in screencast recording per session (feature I10, "replay retention"). */
  record?: boolean;
  /** Starting origin policy for new sessions; empty (every origin asks) by default. */
  policy?: OriginPolicyOptions;
  /**
   * Which partition tasks browse in (feature I15, security §6): `clean` (logged out),
   * `profile` (the owner's sign-ins) or `auto` (default: the profile only for tabs on
   * `signedInOrigins`, logged out everywhere else). Never remembered per task.
   */
  partition?: PartitionMode;
  /** Origins the owner has signed into in the agent profile, for `auto`. */
  signedInOrigins?: string[];
}

export interface ComposedBrowser extends ComposedPart {
  /** Use an authenticated bridge client (what the socket does for each desktop connection). */
  attach(client: BridgeClient): CdpBridgeDriver;
  /** The connected desktop's driver, if any. */
  readonly driver: CdpBridgeDriver | undefined;
  /** Recordings per session key (task id or `thread:<id>`). */
  readonly recordings: ReadonlyMap<string, FileRecordingSink>;
}

/** Status pill text per tool (I5), present progressive as `bridge.tab.status` asks. */
const STATUS: Record<string, string> = {
  "browser.navigate": "Opening page",
  "browser.open_tab": "Opening tab",
  "browser.back": "Going back",
  "browser.forward": "Going forward",
  "browser.reload": "Reloading",
  "browser.snapshot": "Reading page",
  "browser.read_text": "Reading page",
  "browser.find": "Searching page",
  "browser.screenshot": "Looking at page",
  "browser.click": "Clicking",
  "browser.hover": "Pointing",
  "browser.type": "Typing",
  "browser.press": "Pressing keys",
  "browser.select": "Choosing option",
  "browser.scroll": "Scrolling",
  "browser.scroll_to": "Scrolling",
  "browser.drag": "Dragging",
  "browser.upload": "Uploading",
  "browser.download": "Downloading",
  "browser.wait": "Waiting",
  "browser.dialog": "Answering dialog",
  "browser.fill_credential": "Filling sign-in",
};

/** Read-only lookups the tool layer calls synchronously in `describeCall`; never throw. */
const PEEKS = new Set(["peek", "tabOrigin", "pendingDialog"]);

export function composeBrowser(
  services: ComposeServices,
  setup: BrowserSetup = {},
): ComposedBrowser {
  const library = setup.library ?? new FsQuarantineWriter(join(services.home, "library"));
  const recordingsDir = join(services.home, "library", "recordings");
  let client: BridgeClient | undefined;
  let driver: CdpBridgeDriver | undefined;
  let server: BridgeServer | undefined;
  /** Session key (task or thread) → browser session on the current driver. */
  const sessions = new Map<string, Promise<DriverSession>>();
  const recordings = new Map<string, FileRecordingSink>();
  /** Last snapshot boxes per tab, for the action highlight. */
  const boxes = new Map<string, Map<string, RefBox>>();
  const log = services.logger;

  const current = (): CdpBridgeDriver => {
    if (driver === undefined) {
      throw new PsycheError("unavailable", "the browser needs the Psyche desktop app to be open", {
        retryable: true,
      });
    }
    return driver;
  };

  // The tools hold this proxy, so a reconnecting desktop swaps the driver underneath them.
  const driverProxy = new Proxy({} as BrowserDriverEx, {
    get(_target, prop) {
      if (driver === undefined && typeof prop === "string" && PEEKS.has(prop)) {
        return () => undefined;
      }
      const d = current();
      const value = Reflect.get(d, prop, d);
      if (prop === "snapshot" && typeof value === "function") {
        return async (tabId: string, options?: unknown) => {
          const snap = await (value as BrowserDriverEx["snapshot"]).call(
            d,
            tabId,
            options as never,
          );
          const byRef = new Map<string, RefBox>();
          for (const r of snap.refs) if (r.box !== undefined) byRef.set(r.ref, r.box);
          boxes.set(tabId, byRef);
          return snap;
        };
      }
      return typeof value === "function" ? value.bind(d) : value;
    },
  });

  const sessionFor = (callId: string): Promise<string> => {
    const ctx = services.calls.context(callId);
    const key = ctx.taskId ?? `thread:${ctx.threadId}`;
    let session = sessions.get(key);
    if (session === undefined) {
      let recording: FileRecordingSink | undefined;
      if (setup.record === true) {
        recording = new FileRecordingSink(recordingsDir, key);
        recordings.set(key, recording);
      }
      session = current().openSession({
        ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
        ...(setup.policy === undefined ? {} : { policy: structuredClone(setup.policy) }),
        ...(recording === undefined ? {} : { recording }),
        ...(setup.partition === undefined ? {} : { partition: setup.partition }),
        ...(setup.signedInOrigins === undefined ? {} : { signedInOrigins: setup.signedInOrigins }),
      });
      session.catch(() => sessions.delete(key));
      sessions.set(key, session);
    }
    return session.then((s) => s.id);
  };

  const showStatus = (name: string, params: unknown): void => {
    const p = params as { tabId?: unknown; ref?: unknown; target?: { ref?: unknown } };
    const text = STATUS[name];
    if (client === undefined || text === undefined || typeof p?.tabId !== "string") return;
    const ref = typeof p.ref === "string" ? p.ref : p.target?.ref;
    const box = typeof ref === "string" ? boxes.get(p.tabId)?.get(ref) : undefined;
    client
      .call("bridge.tab.status", {
        tabId: p.tabId,
        text,
        ...(box === undefined ? {} : { highlight: box }),
      })
      .catch(() => undefined);
  };

  // Status pill and highlight before each action (I5); the desktop only displays them.
  const tools: ToolRegistry = {
    list: () => services.tools.list(),
    get: (name) => services.tools.get(name),
    register(registration: ToolRegistration) {
      const name = registration.spec.name;
      const execute = registration.execute;
      return services.tools.register({
        ...registration,
        execute: (callId, params, signal, onUpdate) => {
          showStatus(name, params);
          return execute(callId, params, signal, onUpdate);
        },
      });
    },
  };
  const unregister = registerBrowserTools(tools, {
    driver: driverProxy,
    broker: services.broker,
    ...(setup.credentials === undefined ? {} : { credentials: setup.credentials }),
    context: (callId) => services.calls.context(callId),
    session: sessionFor,
  });

  const attach = (next: BridgeClient): CdpBridgeDriver => {
    driver?.dispose();
    sessions.clear();
    boxes.clear();
    client = next;
    driver = new CdpBridgeDriver(next, {
      library,
      broker: services.broker,
    });
    const attached = driver;
    next.onClose((reason) => {
      if (driver !== attached) return;
      log?.log("info", "browser bridge closed", { reason });
      attached.dispose();
      driver = undefined;
      client = undefined;
      sessions.clear();
    });
    log?.log("info", "browser bridge connected");
    return attached;
  };

  return {
    handlers: browserHandlers(() => current(), sessionsForClients),
    attach,
    get driver() {
      return driver;
    },
    recordings,
    async start(gateway: Gateway) {
      if (setup.socketPath === false) return;
      server = new BridgeServer({
        socketPath: setup.socketPath ?? join(services.home, "run", "browser-bridge.sock"),
        handshakeSecret: gateway.handshakeSecret,
        gatewayVersion: "psyched",
        onClient: (c) => void attach(c),
      });
      await server.listen();
    },
    async stop() {
      unregister();
      driver?.dispose();
      driver = undefined;
      await server?.close();
    },
  };

  /** Every live agent session, for `browser.tabs`. */
  async function sessionsForClients(): Promise<DriverSession[]> {
    const all = await Promise.allSettled([...sessions.values()]);
    return all.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  }
}

/**
 * Client-facing `browser.*` (protocol `BrowserMethods`): list, open, close and snapshot tabs.
 * A tab the owner opens lives in its own session whose policy holds only that origin, read-only.
 */
function browserHandlers(
  driver: () => CdpBridgeDriver,
  agentSessions: () => Promise<DriverSession[]>,
): Record<string, HandlerDef> {
  const toTab = (
    t: { id: string; url: string; title: string; partition: "profile" | "clean" },
    taskId: string | null,
  ) => ({
    tabId: t.id,
    url: t.url,
    title: t.title,
    // The pane's indicator (I15): which partition the tab runs in.
    profile: t.partition === "clean" ? ("clean" as const) : ("logged-in" as const),
    controller: "agent" as const,
    taskId,
    driver: "cdp" as const,
  });
  const userSessions: DriverSession[] = [];
  return {
    "browser.tabs": {
      async run(_call: Call, p: MethodParams<"browser.tabs">) {
        const d = driver();
        const tabs = [];
        for (const s of [...(await agentSessions()), ...userSessions]) {
          const taskId = s.taskId ?? null;
          if (p.taskId !== undefined && taskId !== p.taskId) continue;
          const controller = await d.getControlState(s.id).catch(() => "paused" as const);
          for (const t of await d.listTabs(s.id).catch(() => [])) {
            tabs.push({ ...toTab(t, taskId), controller });
          }
        }
        return { tabs };
      },
    },
    "browser.open": {
      async run(_call: Call, p: MethodParams<"browser.open">) {
        const d = driver();
        const origin = new URL(p.url).origin;
        const session = await d.openSession({
          partition: p.profile === "clean" ? "clean" : "profile",
          policy: { readOnly: [origin] },
        });
        userSessions.push(session);
        const tab = await d.openTab(session.id, p.url);
        return { tab: toTab(tab, null) };
      },
    },
    "browser.close": {
      async run(_call: Call, p: MethodParams<"browser.close">) {
        await driver().closeTab(p.tabId);
        return { ok: true };
      },
    },
    "browser.snapshot": {
      async run(_call: Call, p: MethodParams<"browser.snapshot">) {
        const snap = await driver().snapshot(p.tabId);
        return {
          snapshot: {
            tabId: p.tabId,
            url: snap.url,
            title: snap.title,
            tree: snap.text,
            capturedAt: new Date().toISOString(),
          },
        };
      },
    },
  };
}
