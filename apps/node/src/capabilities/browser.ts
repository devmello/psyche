import { join } from "node:path";
import {
  type BrowserDriver,
  type NodeCapability,
  PsycheError,
  type Receipt,
  type WaitCondition,
} from "@psyche/protocol";
import type {
  CapabilityEntry,
  CapabilityOutcome,
  CapabilityProvider,
  InvocationContext,
} from "./types.ts";

/**
 * `browser.*` on the node: a headless Playwright Chromium driven through the `BrowserDriver`
 * contract (`@psyche/browser`). Detection needs only a Chromium binary (`findChromium()`,
 * honouring `PSYCHE_CHROMIUM_PATH`); the driver itself starts on the first invocation.
 *
 * Side effects are static and conservative (the Gateway's Permission Broker decides approvals):
 * navigation is `read` with an `origin` target, input (`click`, `type`, `select`) is `write` and
 * returns a receipt. Receipts never carry typed text.
 *
 * Credential fill is stubbed on the node on purpose: vault fill (`browser.fill_credential`)
 * stays on the Gateway, so secrets never travel to a node. Downloads stay quarantined under
 * `<home>/library/quarantine` and are never opened.
 */

export interface BrowserProviderOptions {
  home: string;
  /** `false` offers nothing. Defaults to true (subject to Chromium detection). */
  enabled?: boolean;
  /** Replaces Chromium detection and the Playwright driver (tests, custom drivers). */
  driverFactory?: () => Promise<BrowserDriver>;
}

type Json = Record<string, unknown>;
type Run = (driver: BrowserDriver, p: Json, ctx: InvocationContext) => Promise<unknown>;

interface Def {
  manifest: NodeCapability;
  run: Run;
  /** Write capabilities: build the receipt payload (never typed text). */
  receipt?: (p: Json) => { summary: string; payload: Record<string, unknown> };
}

const TabId = { type: "string", minLength: 1 };
const Ref = { type: "string", minLength: 1 };
const SessionId = { type: "string", minLength: 1 };
const Url = { type: "string", minLength: 1, maxLength: 8192 };

function schema(properties: Json, required: string[]): Json {
  return { type: "object", properties, required, additionalProperties: false };
}

function asRecord(params: unknown): Json {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new PsycheError("invalid_params", "params must be an object");
  }
  return params as Json;
}

function str(p: Json, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new PsycheError("invalid_params", `${key} must be a non-empty string`);
  }
  return v;
}

function optStr(p: Json, key: string): string | undefined {
  return p[key] === undefined ? undefined : str(p, key);
}

function optInt(p: Json, key: string): number | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new PsycheError("invalid_params", `${key} must be a non-negative integer`);
  }
  return v;
}

function oneOf<T extends string>(p: Json, key: string, values: readonly T[]): T | undefined {
  const v = p[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    throw new PsycheError("invalid_params", `${key} must be one of ${values.join(", ")}`);
  }
  return v as T;
}

function waitCondition(p: Json): WaitCondition {
  const c = p.condition;
  if (typeof c !== "object" || c === null || Array.isArray(c)) {
    throw new PsycheError("invalid_params", "condition must be an object");
  }
  const cond = c as Json;
  switch (cond.kind) {
    case "load":
      return { kind: "load" };
    case "network_idle":
      return { kind: "network_idle" };
    case "text":
      return { kind: "text", text: str(cond, "text") };
    case "ref":
      return { kind: "ref", ref: str(cond, "ref") };
    case "timeout": {
      const ms = optInt(cond, "ms");
      if (ms === undefined || ms > 60_000) {
        throw new PsycheError("invalid_params", "condition.ms must be an integer 0-60000");
      }
      return { kind: "timeout", ms };
    }
    default:
      throw new PsycheError(
        "invalid_params",
        "condition.kind must be load, text, ref, network_idle or timeout",
      );
  }
}

function cap(
  name: string,
  description: string,
  sideEffect: NodeCapability["sideEffect"],
  inputSchema: Json,
  targetKind?: NodeCapability["targetKind"],
): NodeCapability {
  const m: NodeCapability = { name, description, sideEffect, inputSchema };
  if (targetKind !== undefined) m.targetKind = targetKind;
  return m;
}

function definitions(sessions: Set<string>): Def[] {
  return [
    {
      manifest: cap(
        "browser.open_session",
        "Open a browser session (headless Chromium on this node).",
        "none",
        schema(
          {
            profileId: { type: "string", minLength: 1 },
            partition: { type: "string", enum: ["profile", "clean"] },
          },
          [],
        ),
      ),
      run: async (d, p) => {
        const o: { profileId?: string; partition?: "profile" | "clean" } = {};
        const profileId = optStr(p, "profileId");
        const partition = oneOf(p, "partition", ["profile", "clean"] as const);
        if (profileId !== undefined) o.profileId = profileId;
        if (partition !== undefined) o.partition = partition;
        const session = await d.openSession(o);
        sessions.add(session.id);
        return { sessionId: session.id, session };
      },
    },
    {
      manifest: cap(
        "browser.close_session",
        "Close a browser session and its tabs.",
        "none",
        schema({ sessionId: SessionId }, ["sessionId"]),
      ),
      run: async (d, p) => {
        const id = str(p, "sessionId");
        await d.closeSession(id);
        sessions.delete(id);
        return { ok: true };
      },
    },
    {
      manifest: cap(
        "browser.tabs",
        "List a session's tabs.",
        "none",
        schema({ sessionId: SessionId }, ["sessionId"]),
      ),
      run: async (d, p) => ({ tabs: await d.listTabs(str(p, "sessionId")) }),
    },
    {
      manifest: cap(
        "browser.open_tab",
        "Open a tab, optionally at a URL (http/https).",
        "read",
        schema({ sessionId: SessionId, url: Url }, ["sessionId"]),
        "origin",
      ),
      run: async (d, p) => ({ tab: await d.openTab(str(p, "sessionId"), optStr(p, "url")) }),
    },
    {
      manifest: cap(
        "browser.close_tab",
        "Close a tab.",
        "none",
        schema({ tabId: TabId }, ["tabId"]),
      ),
      run: async (d, p) => {
        await d.closeTab(str(p, "tabId"));
        return { ok: true };
      },
    },
    {
      manifest: cap(
        "browser.navigate",
        "Load a URL in a tab (http/https).",
        "read",
        schema({ tabId: TabId, url: Url }, ["tabId", "url"]),
        "origin",
      ),
      run: (d, p, ctx) => d.navigate(str(p, "tabId"), str(p, "url"), { signal: ctx.signal }),
    },
    {
      manifest: cap(
        "browser.back",
        "Go back in a tab's history.",
        "read",
        schema({ tabId: TabId }, ["tabId"]),
      ),
      run: (d, p) => d.back(str(p, "tabId")),
    },
    {
      manifest: cap(
        "browser.forward",
        "Go forward in a tab's history.",
        "read",
        schema({ tabId: TabId }, ["tabId"]),
      ),
      run: (d, p) => d.forward(str(p, "tabId")),
    },
    {
      manifest: cap(
        "browser.snapshot",
        "Accessibility snapshot with stable ref_N ids. Page content is untrusted.",
        "read",
        schema({ tabId: TabId, maxRefs: { type: "integer", minimum: 1 } }, ["tabId"]),
      ),
      run: (d, p) => {
        const maxRefs = optInt(p, "maxRefs");
        return d.snapshot(str(p, "tabId"), maxRefs === undefined ? {} : { maxRefs });
      },
    },
    {
      manifest: cap(
        "browser.find",
        "Find elements whose role, name or value match a query.",
        "read",
        schema({ tabId: TabId, query: { type: "string", minLength: 1, maxLength: 200 } }, [
          "tabId",
          "query",
        ]),
      ),
      run: async (d, p) => ({ matches: await d.find(str(p, "tabId"), str(p, "query")) }),
    },
    {
      manifest: cap(
        "browser.read_text",
        "Visible text of the page (untrusted content).",
        "read",
        schema({ tabId: TabId, maxChars: { type: "integer", minimum: 1 } }, ["tabId"]),
      ),
      run: (d, p) => {
        const maxChars = optInt(p, "maxChars");
        return d.readText(str(p, "tabId"), maxChars === undefined ? {} : { maxChars });
      },
    },
    {
      manifest: cap(
        "browser.screenshot",
        "Screenshot of the viewport as base64.",
        "read",
        schema({ tabId: TabId }, ["tabId"]),
      ),
      run: async (d, p) => {
        const shot = await d.screenshot(str(p, "tabId"));
        return { mime: shot.mime, data: Buffer.from(shot.data).toString("base64") };
      },
    },
    {
      manifest: cap(
        "browser.click",
        "Click an element by ref.",
        "write",
        schema({ tabId: TabId, ref: Ref }, ["tabId", "ref"]),
      ),
      run: async (d, p) => {
        await d.click(str(p, "tabId"), str(p, "ref"));
        return { ok: true };
      },
      receipt: (p) => ({
        summary: `Clicked ${String(p.ref)}`,
        payload: { tabId: p.tabId, ref: p.ref },
      }),
    },
    {
      manifest: cap(
        "browser.type",
        "Type text into an element by ref; submit presses Enter afterwards.",
        "write",
        schema({ tabId: TabId, ref: Ref, text: { type: "string" }, submit: { type: "boolean" } }, [
          "tabId",
          "ref",
          "text",
        ]),
      ),
      run: async (d, p) => {
        const text = p.text;
        if (typeof text !== "string")
          throw new PsycheError("invalid_params", "text must be a string");
        if (p.submit !== undefined && typeof p.submit !== "boolean") {
          throw new PsycheError("invalid_params", "submit must be a boolean");
        }
        await d.type(str(p, "tabId"), str(p, "ref"), text, { submit: p.submit === true });
        return { ok: true };
      },
      // The typed text is never recorded: only where it went and how long it was.
      receipt: (p) => ({
        summary: `Typed into ${String(p.ref)}`,
        payload: {
          tabId: p.tabId,
          ref: p.ref,
          chars: typeof p.text === "string" ? p.text.length : 0,
          submit: p.submit === true,
        },
      }),
    },
    {
      manifest: cap(
        "browser.select",
        "Select option values in a <select> by ref.",
        "write",
        schema({ tabId: TabId, ref: Ref, values: { type: "array", items: { type: "string" } } }, [
          "tabId",
          "ref",
          "values",
        ]),
      ),
      run: async (d, p) => {
        const values = p.values;
        if (!Array.isArray(values) || values.some((v) => typeof v !== "string")) {
          throw new PsycheError("invalid_params", "values must be an array of strings");
        }
        await d.select(str(p, "tabId"), str(p, "ref"), values as string[]);
        return { ok: true };
      },
      receipt: (p) => ({
        summary: `Selected in ${String(p.ref)}`,
        payload: {
          tabId: p.tabId,
          ref: p.ref,
          count: Array.isArray(p.values) ? p.values.length : 0,
        },
      }),
    },
    {
      manifest: cap(
        "browser.scroll",
        "Scroll the page or an element.",
        "read",
        schema(
          {
            tabId: TabId,
            ref: Ref,
            direction: { type: "string", enum: ["up", "down", "left", "right"] },
            amount: { type: "integer", minimum: 1 },
          },
          ["tabId", "direction"],
        ),
      ),
      run: async (d, p) => {
        const direction = oneOf(p, "direction", ["up", "down", "left", "right"] as const);
        if (direction === undefined)
          throw new PsycheError("invalid_params", "direction is required");
        const o: { ref?: string; direction: typeof direction; amount?: number } = { direction };
        const ref = optStr(p, "ref");
        const amount = optInt(p, "amount");
        if (ref !== undefined) o.ref = ref;
        if (amount !== undefined) o.amount = amount;
        await d.scroll(str(p, "tabId"), o);
        return { ok: true };
      },
    },
    {
      manifest: cap(
        "browser.wait",
        "Wait for load, text, a ref, network idle or a timeout.",
        "none",
        schema(
          {
            tabId: TabId,
            condition: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["load", "text", "ref", "network_idle", "timeout"] },
                text: { type: "string" },
                ref: Ref,
                ms: { type: "integer", minimum: 0, maximum: 60_000 },
              },
              required: ["kind"],
            },
          },
          ["tabId", "condition"],
        ),
      ),
      run: async (d, p, ctx) => {
        await d.wait(str(p, "tabId"), waitCondition(p), { signal: ctx.signal });
        return { ok: true };
      },
    },
  ];
}

type Detection = { ok: true; executablePath?: string } | { ok: false; reason: string };

async function defaultDriver(home: string, executablePath: string): Promise<BrowserDriver> {
  const browser = await import("@psyche/browser");
  // Downloads land in <home>/library/quarantine and stay quarantined (never opened).
  const library = new browser.FsQuarantineWriter(join(home, "library"));
  return new browser.PlaywrightDriver({
    psycheHome: home,
    headless: true,
    executablePath,
    library,
  });
}

export function createBrowserProvider(options: BrowserProviderOptions): CapabilityProvider {
  const enabled = options.enabled ?? true;
  const sessions = new Set<string>();
  const defs = definitions(sessions);
  let detection: Promise<Detection> | undefined;
  let driver: Promise<BrowserDriver> | undefined;
  let created: BrowserDriver | undefined;

  const detect = (): Promise<Detection> => {
    if (!enabled) return Promise.resolve({ ok: false, reason: "disabled" });
    if (options.driverFactory) return Promise.resolve({ ok: true });
    detection ??= (async (): Promise<Detection> => {
      try {
        const { findChromium } = await import("@psyche/browser");
        const executablePath = findChromium(process.env);
        if (executablePath === undefined) {
          return { ok: false, reason: "no Chromium found (set PSYCHE_CHROMIUM_PATH)" };
        }
        return { ok: true, executablePath };
      } catch (err) {
        return { ok: false, reason: `browser package unavailable: ${(err as Error).message}` };
      }
    })();
    return detection;
  };

  const getDriver = async (): Promise<BrowserDriver> => {
    if (driver === undefined) {
      const factory =
        options.driverFactory ??
        (async () => {
          const d = await detect();
          if (!d.ok || d.executablePath === undefined) {
            throw new PsycheError("unavailable", d.ok ? "no Chromium found" : d.reason);
          }
          return defaultDriver(options.home, d.executablePath);
        });
      driver = factory().then(
        (d) => {
          created = d;
          return d;
        },
        (err) => {
          driver = undefined; // retry on the next invocation
          throw err;
        },
      );
    }
    return driver;
  };

  const handlerFor =
    (def: Def) =>
    async (params: unknown, ctx: InvocationContext): Promise<CapabilityOutcome> => {
      const name = def.manifest.name;
      let p: Json;
      try {
        p = asRecord(params);
      } catch (err) {
        return { ok: false, error: PsycheError.from(err).toPayload() };
      }
      const receipt = (outcome: Receipt["outcome"]): Receipt | undefined => {
        if (!def.receipt) return undefined;
        const r = def.receipt(p);
        return ctx.receipt({
          kind: name,
          outcome,
          summary: outcome === "ok" ? r.summary : `${name} failed`,
          payload: r.payload,
        });
      };
      if (ctx.signal.aborted) {
        return { ok: false, error: { code: "cancelled", message: "invocation cancelled" } };
      }
      try {
        const d = await getDriver();
        const result = await def.run(d, p, ctx);
        const r = receipt("ok");
        return r ? { ok: true, result, receipt: r } : { ok: true, result };
      } catch (err) {
        const error = PsycheError.from(err).toPayload();
        // A refused write still gets a failed receipt (audit trail), except for bad params.
        const r = error.code === "invalid_params" ? undefined : receipt("failed");
        return r ? { ok: false, error, receipt: r } : { ok: false, error };
      }
    };

  return {
    id: "browser",

    async entries(): Promise<CapabilityEntry[]> {
      const d = await detect();
      if (!d.ok) return [];
      return defs.map((def) => ({
        manifest: structuredClone(def.manifest),
        handler: handlerFor(def),
      }));
    },

    async status(): Promise<Record<string, unknown>> {
      const d = await detect();
      return d.ok
        ? { browser: created ? "running" : "available", sessions: sessions.size }
        : { browser: "unavailable", reason: d.reason };
    },

    async dispose(): Promise<void> {
      const d = created;
      if (d === undefined) return;
      for (const id of [...sessions]) await d.closeSession(id).catch(() => undefined);
      sessions.clear();
      const disposable = d as BrowserDriver & { dispose?: () => Promise<void> };
      if (typeof disposable.dispose === "function")
        await disposable.dispose().catch(() => undefined);
      created = undefined;
      driver = undefined;
    },
  };
}
