import { join } from "node:path";
import {
  type BridgeClient,
  BridgeServer,
  type BrowserDriverEx,
  CdpBridgeDriver,
  DevServerRegistry,
  type DevServerRegistryOptions,
  FileRecordingSink,
  FsQuarantineWriter,
  type LibraryWriter,
  listeningPorts,
  type OriginPolicyOptions,
  type PartitionMode,
  RecordingStore,
  registerBrowserTools,
  type SessionKind,
  systemLoopbackProbes,
} from "@psyche/browser";
import { createLocalProjectVerifier, type LocalProjectVerifier } from "@psyche/permissions";
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
  /**
   * Dev preview (feature I12, security §3.10): which loopback servers tasks may open. Absent
   * means none; the sandbox / exec layer registers servers it starts on `devServers`.
   */
  devPreview?: DevServerRegistryOptions;
  /**
   * The broker's localhost rule. Default: OS probes (`lsof`, `ps`, DNS) against the PIDs
   * registered with `devServers.started({pid})`, behind a refusal of Psyche's own ports;
   * tests pass their own.
   */
  localProject?: LocalProjectVerifier;
  /**
   * The real-Chrome DevTools endpoint while that mode is attached (feature I13, security §6):
   * its port is one of Psyche's own and never a dev server.
   */
  realChromeCdpEndpoint?: string;
}

export interface ComposedBrowser extends ComposedPart {
  /** Use an authenticated bridge client (what the socket does for each desktop connection). */
  attach(client: BridgeClient): CdpBridgeDriver;
  /** The connected desktop's driver, if any. */
  readonly driver: CdpBridgeDriver | undefined;
  /** Live recordings per session key (task id or `thread:<id>`). */
  readonly recordings: ReadonlyMap<string, FileRecordingSink>;
  /** Reads recordings back for `browser.recordings.*`. */
  readonly recordingStore: RecordingStore;
  /** Dev servers tasks may preview; `started` / `stopped` are for whoever launches them. */
  readonly devServers: DevServerRegistry;
  /** What the broker asks about loopback origins (mounted by the composition root). */
  readonly localProject: LocalProjectVerifier;
}

/** Retention for recordings (data model §12: 7 days when enabled). */
const RECORDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

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
  "browser.request_control": "Waiting for you",
};

/** Read-only lookups the tool layer calls synchronously in `describeCall`; never throw. */
const PEEKS = new Set(["peek", "peekSnapshot", "sessionOf", "tabOrigin", "pendingDialog"]);

export function composeBrowser(
  services: ComposeServices,
  setup: BrowserSetup = {},
): ComposedBrowser {
  const library = setup.library ?? new FsQuarantineWriter(join(services.home, "library"));
  const recordingsDir = join(services.home, "library", "recordings");
  let client: BridgeClient | undefined;
  let driver: CdpBridgeDriver | undefined;
  let server: BridgeServer | undefined;
  /** Session key (task or thread, `#dev` for dev preview) → session on the current driver. */
  const sessions = new Map<string, Promise<DriverSession>>();
  // Psyche's own listeners are never the owner's project (security §3.10): the ports parts
  // registered (the Gateway's, a real-Chrome CDP port) plus whatever the Gateway process is
  // listening on right now, which covers OAuth receivers on random ports.
  const unregisterCdp =
    setup.realChromeCdpEndpoint === undefined
      ? () => undefined
      : services.ownPorts.add(
          Number(new URL(setup.realChromeCdpEndpoint.replace(/^ws/, "http")).port),
          "real-Chrome CDP",
        );
  const reservedPorts = async (): Promise<number[]> => [
    ...services.ownPorts.list(),
    ...(await listeningPorts(process.pid)),
  ];
  const devServers = new DevServerRegistry({ ...(setup.devPreview ?? {}), reservedPorts });
  const ownProjectRule = createLocalProjectVerifier(
    systemLoopbackProbes({
      roots: () => devServers.spawnedPids(),
      psychePorts: () => services.ownPorts.list(),
    }),
  );
  const localProject: LocalProjectVerifier = setup.localProject ?? {
    async check(url) {
      const port = url.port ?? (url.scheme === "https" ? 443 : 80);
      if ((await reservedPorts()).includes(port)) return { ok: false, reason: "psyche_port" };
      return ownProjectRule.check(url);
    },
  };
  // Post-fill hygiene (security §4.7) and page-echo detection (S23 design-18) from the vault.
  const creds = setup.credentials;
  const redact = creds === undefined ? undefined : (text: string) => creds.redact(text);
  const recordings = new Map<string, FileRecordingSink>();
  /** Recording id → Library item id, once a finished recording was imported. */
  const recordingItems = new Map<string, string>();
  const recordingStore = new RecordingStore(recordingsDir, {
    live: (id) => {
      const r = recordings.get(id);
      return r === undefined || r.closed ? undefined : r;
    },
    libraryItemId: (id) => recordingItems.get(id),
  });
  // A library writer that also remembers imported recordings for the store.
  const recordingLibrary: LibraryWriter = {
    importDownload: (file, sniffed) => library.importDownload(file, sniffed),
    async importRecording(r) {
      const imported = (await library.importRecording?.(r)) ?? { libraryItemId: r.id };
      recordingItems.set(r.id, imported.libraryItemId);
      return imported;
    },
  };
  /** `browser.recording.updated`, at most once per recording per second. */
  const publishTimers = new Map<string, NodeJS.Timeout>();
  const publishRecording = (id: string): void => {
    if (publishTimers.has(id)) return;
    const timer = setTimeout(() => {
      publishTimers.delete(id);
      void recordingStore
        .summary(id)
        .then((recording) => services.publish("browser.recording.updated", { recording }))
        .catch(() => undefined);
    }, 1000);
    timer.unref?.();
    publishTimers.set(id, timer);
  };
  /** Finish every live recording (the desktop went away, or the Gateway stops). */
  const endRecordings = async (): Promise<void> => {
    for (const [id, sink] of [...recordings]) {
      if (sink.closed) continue;
      await sink.end().catch(() => undefined);
      await recordingLibrary
        .importRecording?.({
          id,
          dir: sink.dir,
          taskId: sink.index.taskId,
          threadId: sink.index.threadId,
          frameCount: sink.index.frames.length,
          eventCount: sink.index.events.length,
        })
        .catch(() => undefined);
    }
  };
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

  const keyFor = (callId: string, kind: SessionKind = "web"): string => {
    const ctx = services.calls.context(callId);
    const base = ctx.taskId ?? `thread:${ctx.threadId}`;
    return kind === "dev_preview" ? `${base}#dev` : base;
  };

  const sessionFor = (callId: string, kind: SessionKind = "web"): Promise<string> => {
    const ctx = services.calls.context(callId);
    const key = keyFor(callId, kind);
    let session = sessions.get(key);
    if (session === undefined) {
      let recording: FileRecordingSink | undefined;
      if (setup.record === true) {
        recording = new FileRecordingSink(recordingsDir, key, {
          ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
          threadId: ctx.threadId,
          ...(setup.credentials === undefined
            ? {}
            : { redact: (text) => setup.credentials?.redact(text) ?? text }),
          onChange: () => publishRecording(key),
        });
        recordings.set(key, recording);
      }
      // The dev-preview session (I12) is logged out and pinned to the approved ports; the
      // tool adds each port and origin after the owner's approval.
      session = current().openSession({
        ...(ctx.taskId === undefined ? {} : { taskId: ctx.taskId }),
        ...(kind === "dev_preview"
          ? { policy: { devPreview: true, loopbackPorts: [] }, partition: "clean" }
          : {
              ...(setup.policy === undefined ? {} : { policy: structuredClone(setup.policy) }),
              ...(setup.partition === undefined ? {} : { partition: setup.partition }),
              ...(setup.signedInOrigins === undefined
                ? {}
                : { signedInOrigins: setup.signedInOrigins }),
            }),
        ...(recording === undefined ? {} : { recording }),
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
    openSessions: async (callId) => {
      const ids: string[] = [];
      for (const kind of ["web", "dev_preview"] as const) {
        const s = sessions.get(keyFor(callId, kind));
        if (s !== undefined) ids.push((await s).id);
      }
      return ids;
    },
    devPreview: devServers,
    ...(redact === undefined ? {} : { containsSecret: (text: string) => redact(text) !== text }),
    // Hand-offs (S20): the pane shows the reason and the owner gets an "input needed" notice.
    async requestControl(req) {
      const host = req.origin === null ? "a page" : new URL(req.origin).host;
      const reason = req.reason.replace(/\s+/g, " ").trim();
      client
        ?.call("bridge.tab.status", {
          tabId: req.tabId,
          text: `Needs you: ${reason}`.slice(0, 200),
        })
        .catch(() => undefined);
      const note = await services.notifier
        .notify({
          kind: "input_needed",
          title: "Psyche needs you in the browser",
          body: `On ${host}, the agent asks: ${reason}. Take control in the browser pane, then hand it back.`,
          ...(req.taskId === undefined ? {} : { taskId: req.taskId }),
          route: "/browser",
          dedupeKey: `browser-control:${req.tabId}`,
        })
        .catch(() => undefined);
      return async () => {
        client?.call("bridge.tab.status", { tabId: req.tabId, text: null }).catch(() => undefined);
        if (note !== undefined) await services.notifier.resolve(note.id).catch(() => undefined);
      };
    },
  });

  const attach = (next: BridgeClient): CdpBridgeDriver => {
    driver?.dispose();
    sessions.clear();
    boxes.clear();
    void endRecordings();
    client = next;
    driver = new CdpBridgeDriver(next, {
      library: recordingLibrary,
      broker: services.broker,
      ...(redact === undefined ? {} : { redact }),
    });
    const attached = driver;
    next.onClose((reason) => {
      if (driver !== attached) return;
      log?.log("info", "browser bridge closed", { reason });
      attached.dispose();
      driver = undefined;
      client = undefined;
      sessions.clear();
      void endRecordings();
    });
    log?.log("info", "browser bridge connected");
    return attached;
  };

  return {
    handlers: {
      ...browserHandlers(() => current(), sessionsForClients),
      ...recordingHandlers(recordingStore, publishRecording),
    },
    attach,
    get driver() {
      return driver;
    },
    recordings,
    recordingStore,
    devServers,
    localProject,
    async start(gateway: Gateway) {
      // Retention runs at boot; recordings are opt-in and short-lived (data model §12).
      void recordingStore.prune(RECORDING_RETENTION_MS).catch(() => undefined);
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
      unregisterCdp();
      driver?.dispose();
      driver = undefined;
      for (const t of publishTimers.values()) clearTimeout(t);
      publishTimers.clear();
      await endRecordings();
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
 * `browser.recordings.*` (feature I10): the replay index, frames and snapshot text Activity
 * scrubs through. Everything comes from the recording files the driver wrote, redacted at
 * write time; `delete` is the only side effect.
 */
function recordingHandlers(
  store: RecordingStore,
  publish: (id: string) => void,
): Record<string, HandlerDef> {
  return {
    "browser.recordings.list": {
      async run(_call: Call, p: MethodParams<"browser.recordings.list">) {
        const all = await store.list({
          ...(p.taskId === undefined ? {} : { taskId: p.taskId }),
          ...(p.threadId === undefined ? {} : { threadId: p.threadId }),
        });
        const start = p.cursor === undefined ? 0 : Number.parseInt(p.cursor, 10);
        if (!Number.isSafeInteger(start) || start < 0) {
          throw new PsycheError("invalid_params", "bad cursor");
        }
        const limit = p.limit ?? 50;
        return {
          recordings: all.slice(start, start + limit),
          nextCursor: start + limit < all.length ? String(start + limit) : null,
        };
      },
    },
    "browser.recordings.get": {
      run(_call: Call, p: MethodParams<"browser.recordings.get">) {
        return store.get(p.recordingId, {
          ...(p.sinceSeq === undefined ? {} : { sinceSeq: p.sinceSeq }),
          ...(p.limit === undefined ? {} : { limit: p.limit }),
        });
      },
    },
    "browser.recordings.frame": {
      run(_call: Call, p: MethodParams<"browser.recordings.frame">) {
        return store.frame(p.recordingId, p.seq);
      },
    },
    "browser.recordings.snapshot": {
      run(_call: Call, p: MethodParams<"browser.recordings.snapshot">) {
        return store.snapshot(p.recordingId, p.seq);
      },
    },
    "browser.recordings.delete": {
      async run(_call: Call, p: MethodParams<"browser.recordings.delete">) {
        await store.delete(p.recordingId);
        publish(p.recordingId);
        return { ok: true };
      },
    },
  };
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
