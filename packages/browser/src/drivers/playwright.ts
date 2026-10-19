import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DriverProfile, PsycheError } from "@psyche/protocol";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Dialog,
  type Page,
} from "playwright-core";
import { checkCdpCommand } from "../bridge/allowlist.ts";
import type { CdpTarget } from "../cdp/page.ts";
import { safeFilename } from "../downloads/library.ts";
import { listProfileNames, profileDir, psycheHome } from "../profiles.ts";
import type { OpenSessionOptions } from "../types.ts";
import { DriverBase, type DriverDeps, newId, type SessionState, type TabState } from "./base.ts";

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
  #contexts = new Map<string, ContextEntry>();
  #persistent = new Map<string, ContextEntry>();
  #pages = new Map<string, Page>();
  #dialogs = new Map<string, Dialog>();
  #downloadDir: string | undefined;

  constructor(options: PlaywrightDriverOptions) {
    super(options);
    this.#o = options;
  }

  async listProfiles(): Promise<DriverProfile[]> {
    if (this.#o.mode === "connect") return [{ id: "default", name: "Chrome", kind: "real_chrome" }];
    const names = await listProfileNames(this.#o.psycheHome ?? psycheHome());
    if (!names.includes("default")) names.unshift("default");
    return names.map((n) => ({ id: n, name: n, kind: "playwright" }));
  }

  #launchOptions() {
    const o: Parameters<typeof chromium.launch>[0] = {
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
        ? await chromium.connectOverCDP(this.#endpoint(), { timeout: 15_000 })
        : await chromium.launch(this.#launchOptions());
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
    const viewport = this.#o.viewport ?? { width: 1280, height: 800 };
    let entry: ContextEntry;
    if (s.session.partition === "clean") {
      // Logged-out task (feature I15): a fresh context that is never written to a profile.
      const browser = await this.#sharedBrowser();
      entry = { context: await browser.newContext({ viewport, acceptDownloads: true }), refs: 1 };
    } else if (this.#o.mode === "connect") {
      const browser = await this.#sharedBrowser();
      const context = browser.contexts()[0];
      if (context === undefined)
        throw new PsycheError("unavailable", "Chrome has no default context");
      entry = { context, refs: 1, persistentKey: "connect" };
    } else {
      const name = o.profileId ?? "default";
      const existing = this.#persistent.get(name);
      if (existing !== undefined) {
        existing.refs += 1;
        entry = existing;
      } else {
        const dir = await profileDir(name, this.#o.psycheHome ?? psycheHome());
        const context = await chromium.launchPersistentContext(dir, {
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
    this.#contexts.set(s.session.id, entry);
  }

  protected override async onSessionClosed(s: SessionState): Promise<void> {
    const entry = this.#contexts.get(s.session.id);
    this.#contexts.delete(s.session.id);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (entry.persistentKey === "connect") return; // never close the user's Chrome
    if (entry.persistentKey !== undefined) this.#persistent.delete(entry.persistentKey);
    await entry.context.close().catch(() => undefined);
    if (entry.tempDir !== undefined) await rm(entry.tempDir, { recursive: true, force: true });
  }

  #context(s: SessionState): BrowserContext {
    const e = this.#contexts.get(s.session.id);
    if (e === undefined) throw new PsycheError("not_found", "session has no browser context");
    return e.context;
  }

  protected async createTab(
    s: SessionState,
    _url: string | undefined,
  ): Promise<{ id: string; target: CdpTarget; url: string }> {
    const page = await this.#context(s).newPage();
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
