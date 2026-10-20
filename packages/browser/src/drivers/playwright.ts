import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DriverProfile, PsycheError } from "@psyche/protocol";
import type {
  Browser,
  BrowserContext,
  BrowserType,
  CDPSession,
  Dialog,
  Page,
} from "playwright-core";
import { checkCdpCommand } from "../bridge/allowlist.ts";
import type { CdpTarget } from "../cdp/page.ts";
import { safeFilename } from "../downloads/library.ts";
import type { TabPartition } from "../origin/partition.ts";
import { listProfileNames, profileDir, psycheHome } from "../profiles.ts";
import type { OpenSessionOptions } from "../types.ts";
import { DriverBase, type DriverDeps, newId, type SessionState, type TabState } from "./base.ts";

/**
 * playwright-core is loaded when a session first needs Chromium, not when the Gateway boots: it
 * was ≈ 75 ms of every start, browser on or off (docs/status/v1-perf.md).
 */
const chromium = async (): Promise<BrowserType> => (await import("playwright-core")).chromium;

/**
 * Playwright driver (ADR-007 modes): `launchPersistentContext` on
 * `$PSYCHE_HOME/browser/profiles/<name>/` for server / headless use, or `connectOverCDP` to a
 * separately launched branded Chrome (real-Chrome mode, feature I13). Playwright owns process,
 * context, popup, download and dialog lifecycle; every page operation goes through a CDP
 * session with the same `PageController` as the bridge driver, so refs, boxes and action
 * semantics match by construction.
 */
export interface PlaywrightDriverOptions extends DriverDeps {
  mode?: "launch" | "connect";
  /** Real-Chrome mode: the DevTools endpoint (127.0.0.1, random port, only while attached). */
  cdpEndpoint?: string;
  psycheHome?: string;
  headless?: boolean;
  executablePath?: string;
  channel?: string;
  viewport?: { width: number; height: number };
}

interface ContextEntry {
  context: BrowserContext;
  refs: number;
  /** Ephemeral (clean partition) context: closed and deleted with its session. */
  tempDir?: string;
  persistentKey?: string;
}

/**
 * A session's contexts by partition (feature I15): the persistent profile (shared between
 * sessions on the same profile) and an ephemeral context that lives and dies with the session.
 * Both are created on first use, so a logged-out task never opens the profile at all.
 */
interface SessionContexts {
  profileId: string;
  profile?: ContextEntry;
  clean?: ContextEntry;
}

function cdpTarget(session: CDPSession): CdpTarget {
  return {
    send: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      // Same allowlist as the bridge, so both drivers can send exactly the same commands.
      const check = checkCdpCommand(method, params);
      if (!check.ok) throw new PsycheError("method_not_allowed", check.reason);
      try {
        // Typed per-method in Playwright; this package speaks raw CDP by name.
        const send = session.send as unknown as (m: string, p?: object) => Promise<unknown>;
        return (await send.call(session, method, params)) as T;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/Target closed|Session closed|has been closed/i.test(message)) {
          throw new PsycheError("not_found", `tab closed: ${message}`);
        }
        throw new PsycheError("internal", `${method} failed: ${message}`, { cause: err });
      }
    },
    on: (listener) => {
      const handler = (e: { method: string; params?: unknown }) => listener(e.method, e.params);
      session.on("event", handler);
      return () => {
        session.off("event", handler);
      };
    },
  };
}

export class PlaywrightDriver extends DriverBase {
  #o: PlaywrightDriverOptions;
  #browser: Browser | undefined;
  #contexts = new Map<string, SessionContexts>();
  #persistent = new Map<string, ContextEntry>();
  #pages = new Map<string, Page>();
  #dialogs = new Map<string, Dialog>();
  #downloadDir: string | undefined;

  constructor(options: PlaywrightDriverOptions) {
    // Real Chrome (connect mode) saves downloads in its own profile folder, outside the
    // Library quarantine (security §6), so they are off there unless a caller opts in.
    super(
      options.mode === "connect" && options.downloads === undefined
        ? { ...options, downloads: "deny" }
        : options,
    );
    this.#o = options;
  }

  async listProfiles(): Promise<DriverProfile[]> {
    if (this.#o.mode === "connect") return [{ id: "default", name: "Chrome", kind: "real_chrome" }];
    const names = await listProfileNames(this.#o.psycheHome ?? psycheHome());
    if (!names.includes("default")) names.unshift("default");
    return names.map((n) => ({ id: n, name: n, kind: "playwright" }));
  }

  #launchOptions() {
    const o: Parameters<BrowserType["launch"]>[0] = {
      headless: this.#o.headless ?? true,
      // Honest UA, no automation flags beyond Playwright's defaults; never a debugging port.
      args: ["--disable-features=Translate,MediaRouter", "--no-first-run"],
    };
    if (this.#o.executablePath !== undefined) o.executablePath = this.#o.executablePath;
    if (this.#o.channel !== undefined) o.channel = this.#o.channel;
    return o;
  }

  async #sharedBrowser(): Promise<Browser> {
    if (this.#browser !== undefined) return this.#browser;
    this.#browser =
      this.#o.mode === "connect"
        ? await (await chromium()).connectOverCDP(this.#endpoint(), { timeout: 15_000 })
        : await (await chromium()).launch(this.#launchOptions());
    if (this.#o.mode === "connect" && (this.#o.downloads ?? "deny") === "deny") {
      // A click that starts a download is cancelled by Chrome itself. This browser-level
      // session belongs to the driver; the model's page sessions cannot reach `Browser.*`.
      const cdp = await this.#browser.newBrowserCDPSession();
      await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" });
    }
    return this.#browser;
  }

  #endpoint(): string {
    const e = this.#o.cdpEndpoint;
    if (e === undefined) throw new PsycheError("invalid_params", "connect mode needs cdpEndpoint");
    const host = new URL(e.replace(/^ws/, "http")).hostname;
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
      throw new PsycheError(
        "policy_denied",
        "real-Chrome mode attaches only to a loopback endpoint",
      );
    }
    return e;
  }

  protected override async onSessionOpened(s: SessionState, o: OpenSessionOptions): Promise<void> {
    this.#contexts.set(s.session.id, { profileId: o.profileId ?? "default" });
    // Contexts open lazily per partition; the session's default one opens now so a launch
    // failure surfaces here rather than on the first tab.
    await this.#contextFor(s, s.partitions.defaultPartition);
  }

  async #contextFor(s: SessionState, partition: TabPartition): Promise<BrowserContext> {
    const sc = this.#contexts.get(s.session.id);
    if (sc === undefined) throw new PsycheError("not_found", "session has no browser context");
    const existing = sc[partition];
    if (existing !== undefined) return existing.context;
    const viewport = this.#o.viewport ?? { width: 1280, height: 800 };
    let entry: ContextEntry;
    if (partition === "clean") {
      // Logged-out tabs (feature I15): a fresh context that is never written to a profile.
      const browser = await this.#sharedBrowser();
      entry = { context: await browser.newContext({ viewport, acceptDownloads: true }), refs: 1 };
    } else if (this.#o.mode === "connect") {
      const browser = await this.#sharedBrowser();
      const context = browser.contexts()[0];
      if (context === undefined)
        throw new PsycheError("unavailable", "Chrome has no default context");
      entry = { context, refs: 1, persistentKey: "connect" };
    } else {
      const name = sc.profileId;
      const shared = this.#persistent.get(name);
      if (shared !== undefined) {
        shared.refs += 1;
        entry = shared;
      } else {
        const dir = await profileDir(name, this.#o.psycheHome ?? psycheHome());
        const context = await (await chromium()).launchPersistentContext(dir, {
          ...this.#launchOptions(),
          viewport,
          acceptDownloads: true,
        });
        entry = { context, refs: 1, persistentKey: name };
        this.#persistent.set(name, entry);
        // A persistent context opens with one blank page; it is not an agent tab.
        for (const p of context.pages()) await p.close().catch(() => undefined);
      }
    }
    sc[partition] = entry;
    return entry.context;
  }

  protected override async onSessionClosed(s: SessionState): Promise<void> {
    const sc = this.#contexts.get(s.session.id);
    this.#contexts.delete(s.session.id);
    if (sc === undefined) return;
    for (const entry of [sc.profile, sc.clean]) {
      if (entry === undefined) continue;
      entry.refs -= 1;
      if (entry.refs > 0) continue;
      if (entry.persistentKey === "connect") continue; // never close the user's Chrome
      if (entry.persistentKey !== undefined) this.#persistent.delete(entry.persistentKey);
      await entry.context.close().catch(() => undefined);
      if (entry.tempDir !== undefined) await rm(entry.tempDir, { recursive: true, force: true });
    }
  }

  protected async createTab(
    s: SessionState,
    _url: string | undefined,
    partition: TabPartition,
  ): Promise<{ id: string; target: CdpTarget; url: string }> {
    const page = await (await this.#contextFor(s, partition)).newPage();
    const id = newId("pwtab");
    return { id, target: await this.#wire(s, id, page), url: page.url() };
  }

  async #wire(s: SessionState, id: string, page: Page): Promise<CdpTarget> {
    this.#pages.set(id, page);
    const session = await page.context().newCDPSession(page);
    page.on("close", () => {
      this.#pages.delete(id);
      this.#dialogs.delete(id);
      this.forgetTab(id);
    });
    // With a listener registered Playwright leaves dialogs open for us to answer.
    page.on("dialog", (dialog) => {
      this.#dialogs.set(id, dialog);
    });
    page.on("popup", (popup) => void this.#adoptPopup(s, id, popup));
    page.on("download", (download) => {
      void (async () => {
        try {
          const dir = await this.#dlDir();
          const path = join(dir, `${newId("pwdl")}-${safeFilename(download.suggestedFilename())}`);
          await download.saveAs(path);
          await this.downloadCompleted(id, {
            path,
            filename: download.suggestedFilename(),
            mime: null,
            url: download.url(),
          });
        } catch (err) {
          this.downloadFailed(id, err instanceof Error ? err.message : String(err));
        }
      })();
    });
    return cdpTarget(session);
  }

  async #adoptPopup(s: SessionState, openerId: string, popup: Page): Promise<void> {
    if (!this.tabs.has(openerId)) return;
    const id = newId("pwtab");
    try {
      const target = await this.#wire(s, id, popup);
      await this.adoptTab(s, id, target, popup.url(), openerId);
    } catch {
      // Closed before we could attach.
    }
  }

  async #dlDir(): Promise<string> {
    this.#downloadDir ??= await mkdtemp(join(tmpdir(), "psyche-dl-"));
    return this.#downloadDir;
  }

  protected override dialogHandlerFor(tabId: string) {
    return async (accept: boolean, promptText?: string) => {
      const d = this.#dialogs.get(tabId);
      this.#dialogs.delete(tabId);
      if (d === undefined) throw new PsycheError("not_found", "no dialog is open");
      if (accept) await d.accept(promptText);
      else await d.dismiss();
    };
  }

  protected async destroyTab(t: TabState): Promise<void> {
    await this.#pages
      .get(t.tab.id)
      ?.close()
      .catch(() => undefined);
  }

  async dispose(): Promise<void> {
    for (const id of [...this.sessions.keys()]) await this.closeSession(id).catch(() => undefined);
    if (this.#o.mode !== "connect") await this.#browser?.close().catch(() => undefined);
    this.#browser = undefined;
    if (this.#downloadDir !== undefined)
      await rm(this.#downloadDir, { recursive: true, force: true });
  }
}
