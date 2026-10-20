// Real packages are imported by relative path on purpose: they list @psyche/testing as a
// devDependency, so declaring them in package.json would make a workspace cycle turbo rejects.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalKind,
  type AuditLog,
  type BrowserDriver,
  type PermissionBroker,
  PsycheError,
  type SideEffect,
  type Target,
  type TargetKind,
  type ToolResult,
} from "@psyche/protocol";
import {
  type AgentToolRegistration,
  bindingHash,
  paramsHash,
} from "../../../agent-core/src/index.ts";
import {
  braveProvider,
  type ConnectorRecord,
  type ConnectorTool,
  type SearchProvider,
  ShoppingConnector,
  safeFetch,
  type Transport,
} from "../../../connectors/src/index.ts";
import { PaymentBroker, type PurchaseInput } from "../../../vault/src/payments/broker.ts";
import { SecretRedactor } from "../../../vault/src/redact.ts";
import type { FakeClock } from "../clock.ts";
import {
  FakeBrowserDriver,
  type FixtureElement,
  type FixturePage,
} from "../fakes/FakeBrowserDriver.ts";
import { FakeCredentialBroker } from "../fakes/FakeCredentialBroker.ts";
import type { FakeNotifier } from "../fakes/FakeNotifier.ts";
import { fixtureSecret } from "../secret-registry.ts";
import { type CheckoutField, FixtureCheckout, ScenarioLinkWallet } from "./payments.ts";
import {
  cancelDescription,
  type FlightsFixture,
  FlightsWorld,
  holdDescription,
  money,
  segmentLine,
  TEST_FUNDING,
  ticketDescription,
} from "./travel.ts";
import type { Json } from "./types.ts";
import { originOf, tzOffset } from "./util.ts";

/** One row of `tests/scenarios/shared/tools.json`. */
export interface ToolInfo {
  name: string;
  sideEffect: SideEffect;
  targetKind: TargetKind | null;
  provenanceOut: "trusted" | "untrusted";
  connector?: string;
  approvalKind?: ApprovalKind;
  receiptKind?: string;
}

export interface Fixtures {
  dir: string;
  owner: Json & { owner: { email: string; timezone: string } };
  mailbox?: { messages: Json[] };
  calendar?: { events: Json[]; timeZone: string };
  preferences?: Json;
  /** `merchants`: the shopping allowlist (V3); pages with `elements` are storefronts. */
  sites?: { pages: Json[]; merchants?: Json[] };
  searchResults?: { queries: { match: string[]; results: Json[] }[]; fallback?: Json[] };
  /** V4: fixture airlines, fares and the traveler. */
  flights?: FlightsFixture;
}

export type ToolRun = (params: Json, ctx: ToolCtx) => Promise<ToolResult>;
/** A fake executor: the tool's registry row, its arguments and the call context. */
export type ToolImpl = (info: ToolInfo, a: Json, ctx: ToolCtx) => Promise<ToolResult>;
export interface ToolCtx {
  callId: string;
  taskId?: string;
  approvalId?: string;
}

export interface Egress {
  step: string;
  callId?: string;
  via: "connector" | "fetch" | "browser" | "smtp";
  host: string;
  url?: string;
  allowedBy?: string;
}

const GOOGLE_ACTION: Record<string, string> = {
  "gmail.search": "gmail.read",
  "gmail.get": "gmail.read",
  "gmail.draft": "gmail.draft",
  "gmail.send": "gmail.send",
  "gmail.forward": "gmail.send",
  "calendar.list": "calendar.read",
  "calendar.freebusy": "calendar.read",
  "calendar.create": "calendar.write",
  "calendar.update": "calendar.write",
  "search.web": "search.web",
};

/** Connector matrix key for a tool (the Gateway knows it; the loop's intent does not carry it). */
export function connectorOf(info: ToolInfo | undefined) {
  if (info?.connector === undefined) return undefined;
  return { id: info.connector, action: GOOGLE_ACTION[info.name] ?? info.name };
}

const BRAVE_ORIGIN = "https://api.search.brave.com";

/** Canonical target from the arguments (the model only emits arguments). */
export function targetOf(info: ToolInfo, args: Json): Target | undefined {
  if (info.targetKind === "account" && typeof args.account === "string")
    return { kind: "account", value: args.account };
  if (info.targetKind === "recipient" && Array.isArray(args.to))
    return { kind: "recipient", value: args.to.join(",") };
  if (info.name === "search.web") return { kind: "origin", value: BRAVE_ORIGIN };
  // Shopping tools name their store by origin (`merchant`), travel tools their airline.
  const origin =
    info.targetKind === "origin" ? originOf(args.url ?? args.merchant ?? args.airline) : undefined;
  return origin === undefined ? undefined : { kind: "origin", value: origin };
}

/** Start and end instants of an event (all-day events span local midnights in `tz`). */
export function eventSpan(e: Json, tz: string): { s: number; e: number } {
  const at = (t: Json) => {
    if (typeof t.dateTime === "string") return Date.parse(t.dateTime);
    const noon = Date.parse(`${t.date}T12:00:00Z`);
    return Date.parse(`${t.date}T00:00:00Z`) - tzOffset(tz, noon) * 60_000;
  };
  return { s: at(e.start as Json), e: at(e.end as Json) };
}

/** Busy intervals per the fixture's busy rules (declined and transparent events are free). */
export function busyIntervals(events: Json[], tz: string, owner: string) {
  return events
    .filter((e) => e.kind !== "recurring_master" && e.status !== "cancelled")
    .filter((e) => e.transparency !== "transparent")
    .filter(
      (e) =>
        (e.attendees as Json[] | undefined)?.find((a) => a.email === owner)?.responseStatus !==
        "declined",
    )
    .map((e) => ({ id: String(e.id), ...eventSpan(e, tz) }));
}

const sha256hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const counter = () => {
  const n = new Map<string, number>();
  return (prefix: string) => {
    const v = (n.get(prefix) ?? 0) + 1;
    n.set(prefix, v);
    return `${prefix}_${String(v).padStart(4, "0")}`;
  };
};

/** Scenario tool name → shopping connector tool (V3). */
const SHOP_TOOL: Record<string, string> = {
  "shop.compare": "shop_compare",
  "shop.view_cart": "shop_view_cart",
  "shop.add_to_cart": "shop_add_to_cart",
  "shop.checkout_handoff": "shop_checkout_handoff",
  // Same cart check as the hand-off, then Stripe Link pays (G12): see `#payWithLink`.
  "shop.pay_with_link": "shop_checkout_handoff",
};

/** HTML → text with one line per block element (storefront fixtures). */
function blockText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|li|h[1-6]|tr|table|ul|ol|section|header|footer)>|<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) =>
      l
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\|\s*$/, "")
        .trim(),
    )
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * The fake services a scenario runs against (Gmail, Calendar, Library, artifacts, reminders,
 * Brave search over a fake HTTP layer, fetch and the browser over the fixture site set) and
 * everything the assertions inspect afterwards.
 */
export class World {
  readonly fx: Fixtures;
  readonly owner: string;
  readonly tz: string;
  readonly drafts: Json[] = [];
  readonly sent: Json[] = [];
  readonly events: Json[];
  readonly library: Json[] = [];
  readonly artifacts: Json[] = [];
  readonly egress: Egress[] = [];
  readonly blocked: { step: string; callId: string; host: string; via: string; rule: string }[] =
    [];
  readonly results: { step: string; callId: string; tool: string; output: unknown }[] = [];
  readonly outbound: unknown[] = [];
  readonly fetched = new Set<string>();
  readonly sources = new Map<string, string[]>();
  readonly dispatched = new Set<string>();
  readonly faults = new Map<string, Json>();
  readonly credentials: FakeCredentialBroker;
  readonly browser: FakeBrowserDriver;
  step = "";
  #id = counter();
  #search: SearchProvider;

  readonly clock: FakeClock;
  readonly notifier: FakeNotifier;
  readonly broker: () => PermissionBroker;

  readonly audit: AuditLog | undefined;

  constructor(
    fx: Fixtures,
    clock: FakeClock,
    notifier: FakeNotifier,
    broker: () => PermissionBroker,
    audit?: AuditLog,
  ) {
    this.fx = fx;
    this.audit = audit;
    this.#flights = fx.flights === undefined ? undefined : new FlightsWorld(fx.flights);
    this.clock = clock;
    this.notifier = notifier;
    this.broker = broker;
    this.owner = fx.owner.owner.email;
    this.tz = fx.owner.owner.timezone;
    this.events = structuredClone(fx.calendar?.events ?? []);
    this.credentials = new FakeCredentialBroker({ clock });
    this.credentials.add({
      slug: "brave-search-key",
      kind: "api_key",
      bindings: [{ origin: BRAVE_ORIGIN }],
      secret: fixtureSecret("brave-search-key", "token"),
    });
    // The owner approved the key for the provider origin when connecting (standing `site`).
    this.credentials.approve("cfa_brave_connect", {
      slug: "brave-search-key",
      origin: BRAVE_ORIGIN,
      scope: "site",
    });
    this.#search = braveProvider({
      fetch: (url, init) => this.#braveHttp(String(url), init),
      credentials: this.credentials,
      apiKey: "{{cred:brave-search-key}}",
      approveKey: async () => "cfa_brave_connect",
    });
    const pages: Record<string, FixturePage> = {};
    for (const p of fx.sites?.pages ?? []) {
      const html = p.file === undefined ? "" : this.#page(p);
      const page: FixturePage = {
        title: String(p.title),
        // Storefronts keep one line per block element so offers and cart rows stay apart.
        text: Array.isArray(p.elements)
          ? blockText(html)
          : html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "),
        status: Number(p.status),
      };
      if (Array.isArray(p.elements)) page.elements = p.elements as unknown as FixtureElement[];
      pages[String(p.url)] = page;
    }
    this.browser = FakeBrowserDriver.site({ pages });
    const merchants = fx.sites?.merchants;
    if (merchants !== undefined) {
      const record: ConnectorRecord = {
        id: "con_shopping",
        type: "shopping",
        label: "Shopping",
        account: null,
        scopes: ["shop.read", "shop.cart"],
        scopeMode: "read_act",
        actionMatrix: {},
        credentialId: null,
        status: "connected",
        config: { merchants } as unknown as ConnectorRecord["config"],
        lastSync: null,
        createdAt: new Date(clock.now()).toISOString(),
        updatedAt: new Date(clock.now()).toISOString(),
      };
      const shop = new ShoppingConnector(
        record,
        {
          clock,
          fetch: () => Promise.reject(new Error("no network")),
          tokens: { load: async () => undefined, save: async () => {}, clear: async () => {} },
          emit: () => {},
        },
        { browser: this.#recordingBrowser() },
      );
      for (const t of shop.tools()) this.#shopTools.set(t.name, t);
    }
  }

  readonly #shopTools = new Map<string, ConnectorTool>();
  readonly #flights: FlightsWorld | undefined;
  /** V4 bookings by hold reference and by confirmation number (never card data). */
  readonly bookings = new Map<
    string,
    {
      spendRequestId: string;
      offerId: string;
      airlineId: string;
      amountMinor: number;
      currency: string;
      flights: string[];
      holdRef: string;
      confirmation?: string;
    }
  >();

  /** The fixture browser with every navigation recorded as connector egress. */
  #recordingBrowser(): BrowserDriver {
    const browser = this.browser;
    const net = (url: string) =>
      this.#net({ via: "browser", host: new URL(url).host, url, allowedBy: "connector:shopping" });
    return new Proxy(browser, {
      get(target, key) {
        if (key === "navigate") {
          return (tabId: string, url: string, options?: unknown) => {
            net(url);
            return target.navigate(tabId, url, options as never);
          };
        }
        const v = Reflect.get(target, key, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  /** The shopping connector's own call description (purchase / connector_action binding). */
  shopDescribe(info: ToolInfo, params: Json) {
    if (info.name.startsWith("travel.")) return this.#travelDescribe(info, params);
    const d = this.#shopTools.get(SHOP_TOOL[info.name] ?? "")?.describeCall?.(params);
    if (d === undefined || info.name !== "shop.pay_with_link") return d;
    // Paying binds the payment source too, so a hand-off card can never authorize a payment.
    const fields = (d.bindingFields ?? {}) as Record<string, unknown>;
    const amount = String(fields.amount ?? "");
    const items = (Array.isArray(params.items) ? params.items : []) as Json[];
    const count = items.reduce((n, i) => n + Number(i.qty ?? 0), 0);
    return {
      ...d,
      bindingFields: { ...fields, paymentSourceId: "stripe_link" },
      summary: `Pay ${amount} at ${d.target?.display ?? d.target?.value ?? "the merchant"} for ${count} item(s) with Stripe Link (one-time card)`,
    };
  }

  #page(p: Json): string {
    return readFileSync(join(this.fx.dir, "fixtures/sites", String(p.file)), "utf8");
  }

  #net(e: Omit<Egress, "step">): void {
    this.egress.push({ step: this.step, ...e });
  }

  /** Brave Web Search, faked at the HTTP layer: answers only with the vault key in the header. */
  async #braveHttp(url: string, init?: RequestInit): Promise<Response> {
    const u = new URL(url);
    this.#net({ via: "connector", host: u.host, url, allowedBy: "connector:search:brave" });
    this.outbound.push({ url, method: init?.method ?? "GET" });
    const headers = new Headers(init?.headers);
    if (headers.get("x-subscription-token") !== fixtureSecret("brave-search-key", "token")) {
      return new Response("{}", { status: 401 });
    }
    const q = (u.searchParams.get("q") ?? "").toLowerCase();
    const sr = this.fx.searchResults;
    const hit = sr?.queries.find((e) => e.match.every((t) => q.includes(t.toLowerCase())));
    const results = (hit?.results ?? sr?.fallback ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      description: r.description,
      ...(r.age === undefined ? {} : { page_age: r.age }),
    }));
    return Response.json({ web: { results } });
  }

  /** Origins the Task may read: live `new_origin` grants plus the call's own approval. */
  async allowedOrigins(ctx: ToolCtx): Promise<Set<string>> {
    const broker = this.broker();
    const out = new Set<string>();
    for (const g of await broker.listGrants({ kind: "new_origin" })) {
      if (g.expiresAt != null && Date.parse(g.expiresAt) <= this.clock.now()) continue;
      if (g.scope === "task" && g.taskId !== ctx.taskId) continue;
      const o = originOf((g.subject.target as Target | undefined)?.value);
      if (o !== undefined) out.add(o);
    }
    const a = ctx.approvalId === undefined ? undefined : await broker.get(ctx.approvalId);
    const o = a?.status === "approved" ? originOf(a.target?.value) : undefined;
    if (o !== undefined) out.add(o);
    return out;
  }

  /** The fake network for `safeFetch`: fixture pages only; hops outside the origin set refused. */
  #transport(callId: string, allowed: Set<string>): Transport {
    let hop = 0;
    return async (req) => {
      const url = req.url.toString();
      const origin = req.url.origin;
      if (!allowed.has(origin)) {
        const rule = hop === 0 ? "origin_not_approved" : "redirect_not_allowlisted";
        this.blocked.push({ step: this.step, callId, host: req.url.host, via: "fetch", rule });
        throw new PsycheError("policy_denied", `${rule}: ${req.url.host}`, {
          details: { reason: rule },
        });
      }
      hop += 1;
      this.#net({ callId, via: "fetch", host: req.url.host, url, allowedBy: `origin:${origin}` });
      const page = this.fx.sites?.pages.find((p) => p.url === url);
      if (page === undefined) throw new Error(`network error: ${req.url.host}`);
      const body =
        page.file === undefined ? "<html><body>Not found</body></html>" : this.#page(page);
      return {
        status: Number(page.status),
        headers: {
          "content-type": "text/html; charset=utf-8",
          ...(page.location === undefined ? {} : { location: String(page.location) }),
        },
        body: (async function* () {
          yield new TextEncoder().encode(body);
        })(),
        close: () => undefined,
      };
    };
  }

  async #receipt(info: ToolInfo, ctx: ToolCtx, refs: Record<string, string>, verified: boolean) {
    const r = await this.broker().recordReceipt({
      kind: info.receiptKind ?? info.name,
      outcome: "ok",
      summary: `${info.name} ${Object.values(refs).join(" ")}`,
      taskId: ctx.taskId ?? null,
      toolCallId: ctx.callId,
      approvalId: ctx.approvalId ?? null,
      externalRefs: refs,
      payload: { evaluator: { verdict: verified ? "verified" : "failed" } },
    });
    return r.id;
  }

  #google(ctx: ToolCtx, api: string) {
    this.#net({ callId: ctx.callId, via: "connector", host: api, allowedBy: "connector:google" });
  }

  #mail(id: string): Json | undefined {
    return this.fx.mailbox?.messages.find((m) => m.id === id);
  }

  /** Executors by tool name; the runner wraps them with the binding re-check and fault hooks. */
  impls(): Record<string, ToolImpl> {
    const ok = (output: unknown, provenance: "trusted" | "untrusted" = "trusted"): ToolResult => ({
      output,
      provenance,
    });
    const taint = (ctx: ToolCtx, sources: string[]) =>
      this.sources.set(ctx.callId, [...new Set(sources)]);
    const fail = (error: string, extra: Json = {}): ToolResult => ({
      output: { error, ...extra },
      isError: true,
      provenance: "trusted",
    });
    return {
      "gmail.search": async (_i, a, ctx) => {
        this.#google(ctx, "gmail.googleapis.com");
        const since = this.clock.now() - 5 * 86_400_000;
        const hits = (this.fx.mailbox?.messages ?? [])
          .filter((m) => (m.labelIds as string[]).includes("INBOX"))
          .filter((m) => Date.parse(String(m.internalDate)) >= since)
          .slice(0, Number(a.maxResults ?? 50));
        taint(
          ctx,
          hits.map((m) => `email:${(m.from as Json).email}`),
        );
        return ok(
          hits.map((m) => ({
            id: m.id,
            threadId: m.threadId,
            from: m.from,
            subject: m.subject,
            snippet: m.snippet,
            date: m.internalDate,
          })),
          "untrusted",
        );
      },
      "gmail.get": async (_i, a, ctx) => {
        this.#google(ctx, "gmail.googleapis.com");
        const m = this.#mail(String(a.messageId));
        if (m === undefined) return fail("message not found");
        const { expected: _e, ...msg } = m;
        taint(ctx, [`email:${(m.from as Json).email}`]);
        return ok(msg, "untrusted");
      },
      "gmail.draft": async (info, a, ctx) => {
        this.#google(ctx, "gmail.googleapis.com");
        const id = this.#id("dr");
        this.drafts.push({ id, ...structuredClone(a) });
        const receiptId = await this.#receipt(info, ctx, { draftId: id }, true);
        return { ...ok({ draftId: id }), receiptId };
      },
      "gmail.send": async (info, a, ctx) => {
        this.#google(ctx, "gmail.googleapis.com");
        const approval =
          ctx.approvalId === undefined ? undefined : await this.broker().get(ctx.approvalId);
        const by = approval?.status === "approved" ? `approval:${approval.id}` : undefined;
        for (const to of [a.to, a.cc, a.bcc].flat().filter((x) => typeof x === "string")) {
          this.#net({
            callId: ctx.callId,
            via: "smtp",
            host: String(to),
            ...(by ? { allowedBy: by } : {}),
          });
        }
        this.outbound.push(structuredClone(a));
        const id = this.#id("sent");
        const threadId = typeof a.threadId === "string" ? a.threadId : `thr_${id}`;
        this.sent.push({
          id,
          ...structuredClone(a),
          threadId,
          messageId: `<${id}@mail.example.com>`,
        });
        const verified = this.sent.some((m) => m.id === id);
        const receiptId = await this.#receipt(info, ctx, { messageId: id, threadId }, verified);
        return { ...ok({ messageId: id, threadId }), receiptId };
      },
      "library.save": async (_i, a, ctx) => {
        const src = a.source as Json;
        const att = (this.#mail(String(src.messageId))?.attachments as Json[] | undefined)?.find(
          (x) => x.id === src.attachmentId,
        );
        if (att === undefined) return fail("attachment not found");
        this.#google(ctx, "gmail.googleapis.com");
        const bytes = readFileSync(join(this.fx.dir, "fixtures", String(att.path)));
        const sha256 = sha256hex(bytes);
        const existing = this.library.find((l) => l.sha256 === sha256);
        if (existing !== undefined) return ok({ libraryItemId: existing.id, deduplicated: true });
        const item = {
          id: this.#id("lib"),
          kind: "document",
          name: a.name ?? att.filename,
          mime: att.mimeType,
          sha256,
          origin: "connector",
          tags: a.tags ?? [],
        };
        this.library.push(item);
        return ok({ libraryItemId: item.id });
      },
      "calendar.list": async (_i, a, ctx) => {
        this.#google(ctx, "www.googleapis.com");
        const lo = Date.parse(String(a.timeMin));
        const hi = Date.parse(String(a.timeMax));
        const items = this.events
          .filter((e) => e.kind !== "recurring_master" && e.status !== "cancelled")
          .filter((e) => {
            const span = eventSpan(e, this.tz);
            return span.s < hi && lo < span.e;
          })
          .map(({ expected: _e, kind: _k, ...e }) => e);
        taint(
          ctx,
          items.flatMap((e) => {
            const org = (e.organizer as Json | undefined)?.email;
            return org === undefined || org === this.owner ? [] : [`calendar:${org}`];
          }),
        );
        return ok({ items }, "untrusted");
      },
      "calendar.freebusy": async (_i, a, ctx) => {
        this.#google(ctx, "www.googleapis.com");
        const lo = Date.parse(String(a.timeMin));
        const hi = Date.parse(String(a.timeMax));
        const busy = busyIntervals(this.events, this.tz, this.owner)
          .filter((b) => b.s < hi && lo < b.e)
          .sort((x, y) => x.s - y.s)
          .map((b) => ({ start: new Date(b.s).toISOString(), end: new Date(b.e).toISOString() }));
        return ok({ calendars: { primary: { busy } } });
      },
      "calendar.create": async (info, a, ctx) => {
        this.#google(ctx, "www.googleapis.com");
        let ev = this.events.find((e) => a.requestId !== undefined && e.requestId === a.requestId);
        if (ev === undefined) {
          const id = this.#id("evt_created");
          ev = {
            kind: "single",
            status: "confirmed",
            transparency: "opaque",
            ...structuredClone(a.event as Json),
            id,
            iCalUID: `${id}@google.com`,
            organizer: { email: a.account, self: true },
            ...(a.requestId === undefined ? {} : { requestId: a.requestId }),
          };
          this.events.push(ev);
        }
        const refs = { eventId: String(ev.id), iCalUID: String(ev.iCalUID) };
        const receiptId = await this.#receipt(info, ctx, refs, this.events.includes(ev));
        return { ...ok(refs), receiptId };
      },
      "calendar.update": async (info, a, ctx) => {
        this.#google(ctx, "www.googleapis.com");
        const ev = this.events.find((e) => e.id === a.eventId);
        if (ev === undefined) return fail("event not found", { httpStatus: 404 });
        Object.assign(ev, structuredClone(a.event as Json));
        const receiptId = await this.#receipt(info, ctx, { eventId: String(ev.id) }, true);
        return { ...ok({ eventId: ev.id }), receiptId };
      },
      "reminders.create": async (_i, a) => {
        const id = this.#id("rem");
        this.clock.setTimer(Date.parse(String(a.at)), () => {
          void this.notifier.notify({
            kind: "reminder",
            title: String(a.text),
            body: String(a.text),
          });
        });
        return ok({ reminderId: id, at: a.at });
      },
      "search.web": async (_i, a, ctx) => {
        const hits = await this.#search.search(String(a.query), { count: Number(a.count ?? 8) });
        taint(
          ctx,
          hits.map((h) => `web:${originOf(h.url)}`),
        );
        return ok({ results: hits }, "untrusted");
      },
      fetch: async (_i, a, ctx) => {
        const url = String(a.url);
        const allowed = await this.allowedOrigins(ctx);
        const r = await safeFetch(url, {
          lookup: async () => [{ address: "93.184.215.14", family: 4 }],
          // The real per-hop check (#72); the fake transport keeps its own as a backstop.
          allowHop: (next) => {
            if (allowed.has(next.origin)) return true;
            this.blocked.push({
              step: this.step,
              callId: ctx.callId,
              host: next.host,
              via: "fetch",
              rule: "redirect_not_allowlisted",
            });
            return false;
          },
          transport: this.#transport(ctx.callId, allowed),
          maxChars: Number(a.maxBytes ?? 200_000),
        });
        taint(ctx, [`web:${originOf(url)}`]);
        if (r.status >= 400)
          return { ...fail(`HTTP ${r.status}`, { httpStatus: r.status }), provenance: "untrusted" };
        this.fetched.add(url);
        return ok(
          { url: r.url, status: r.status, title: r.title, markdown: r.markdown },
          "untrusted",
        );
      },
      "browser.navigate": async (_i, a, ctx) => {
        const url = String(a.url);
        const origin = originOf(url) ?? "";
        if (!(await this.allowedOrigins(ctx)).has(origin)) {
          this.blocked.push({
            step: this.step,
            callId: ctx.callId,
            host: new URL(url).host,
            via: "browser",
            rule: "origin_not_approved",
          });
          return fail("origin_not_approved", { errorCode: "origin_not_approved" });
        }
        this.#net({
          callId: ctx.callId,
          via: "browser",
          host: new URL(url).host,
          url,
          allowedBy: `origin:${origin}`,
        });
        const session = await this.browser.openSession({
          ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
        });
        const tab = await this.browser.openTab(session.id, url);
        const page = await this.browser.readText(tab.id);
        taint(ctx, [`web:${origin}`]);
        return ok({ url, title: tab.title, text: page.text }, "untrusted");
      },
      ...this.#shopImpls(ok, taint),
      ...this.#travelImpls(ok, taint),
      "artifacts.write": async (_i, a) => {
        const name = String(a.name);
        let art = this.artifacts.find((x) => x.name === name && x.type === a.type);
        if (art === undefined) {
          art = { id: this.#id("art"), name };
          this.artifacts.push(art);
          this.library.push({
            id: this.#id("lib"),
            kind: "artifact",
            name,
            mime: mimeOf(String(a.type)),
            origin: "agent",
            artifactId: art.id,
          });
        }
        Object.assign(art, { type: a.type, title: a.title, content: a.content });
        return ok({ artifactId: art.id });
      },
      "artifacts.export_pdf": async (_i, a) => {
        const src = this.artifacts.find((x) => x.name === a.name && x.type === "markdown");
        if (src === undefined) return fail("artifact not found");
        const name = `${a.name}.pdf`;
        if (!this.artifacts.some((x) => x.name === name)) {
          const id = this.#id("art");
          this.artifacts.push({ id, type: "pdf", name, title: src.title, content: src.content });
          this.library.push({
            id: this.#id("lib"),
            kind: "artifact",
            name,
            mime: "application/pdf",
            origin: "agent",
            artifactId: id,
          });
        }
        return ok({ name });
      },
    };
  }

  /**
   * V3 shopping tools: the real `ShoppingConnector` (packages/connectors) over the fixture
   * storefronts. The agent loop and the Permission Broker gate them; writes and the hand-off
   * record receipts here, as the connector registry would.
   */
  #shopImpls(
    ok: (output: unknown, provenance?: "trusted" | "untrusted") => ToolResult,
    taint: (ctx: ToolCtx, sources: string[]) => void,
  ): Record<string, (info: ToolInfo, a: Json, ctx: ToolCtx) => Promise<ToolResult>> {
    const out: Record<string, (info: ToolInfo, a: Json, ctx: ToolCtx) => Promise<ToolResult>> = {};
    for (const [name, toolName] of Object.entries(SHOP_TOOL)) {
      if (name === "shop.pay_with_link") {
        out[name] = (info, a, ctx) => this.#payWithLink(info, a, ctx, ok, taint);
        continue;
      }
      out[name] = async (info, a, ctx) => {
        const tool = this.#shopTools.get(toolName);
        if (tool === undefined) throw new PsycheError("unavailable", "no shopping fixtures");
        const r = await tool.execute(a, {
          signal: new AbortController().signal,
          callId: ctx.callId,
        });
        const merchants = (this.fx.sites?.merchants ?? []).map((m) => String(m.origin));
        const origin = originOf(a.merchant);
        taint(
          ctx,
          (origin === undefined ? merchants : [origin]).map((o) => `web:${o}`),
        );
        if (info.receiptKind === undefined) return ok(r.output, r.provenance);
        const refs = Object.fromEntries(
          Object.entries(r.externalRefs ?? {}).map(([k, v]) => [k, String(v)]),
        );
        // Returning the id tells the loop the write is already receipted (no second receipt).
        const receiptId = await this.#receipt(info, ctx, refs, true);
        return { ...ok(r.output, r.provenance), receiptId };
      };
    }
    return out;
  }

  /** Stripe Link in test mode (G12): the wallet, the vault's payment broker, merchant pages. */
  readonly linkWallet = new ScenarioLinkWallet((what) =>
    this.#net({
      via: "connector",
      host: "api.link.com",
      url: `link-cli ${what}`,
      allowedBy: "connector:stripe_link",
    }),
  );
  readonly checkouts: FixtureCheckout[] = [];
  /** Values the payment path masks; shared with the vault broker. */
  readonly paymentRedactor = new SecretRedactor();
  #payments: PaymentBroker | undefined;

  #paymentBroker(): PaymentBroker {
    this.#payments ??= new PaymentBroker({
      home: mkdtempSync(join(tmpdir(), "psyche-v3-")),
      wallet: this.linkWallet,
      permissions: this.broker(),
      redactor: this.paymentRedactor,
      clock: this.clock,
      // Every purchase transition lands in the scenario's audit chain next to the receipt.
      ...(this.audit === undefined ? {} : { audit: this.audit }),
    });
    return this.#payments;
  }

  /**
   * `shop.pay_with_link`: the connector re-reads the live cart (the hand-off check: items and
   * total must equal the approved arguments), then the vault's `PaymentBroker` takes over. It
   * re-checks the purchase approval the loop dispatched against this call's binding hash, creates
   * a Link spend request in test mode, waits for the owner's approval in Link, has Link write the
   * one-time card to a 0600 file, fills the merchant's card form field by field through the
   * browser fill core, and records the `purchase` receipt with the Link reference and order
   * number. The model gets brand / last4 and the order number only.
   */
  async #payWithLink(
    info: ToolInfo,
    a: Json,
    ctx: ToolCtx,
    ok: (output: unknown, provenance?: "trusted" | "untrusted") => ToolResult,
    taint: (ctx: ToolCtx, sources: string[]) => void,
  ): Promise<ToolResult> {
    const handoff = this.#shopTools.get("shop_checkout_handoff");
    if (handoff === undefined) throw new PsycheError("unavailable", "no shopping fixtures");
    if (ctx.approvalId === undefined)
      throw new PsycheError("approval_required", "paying needs the purchase approval");
    const origin = originOf(a.merchant);
    if (origin !== undefined) taint(ctx, [`web:${origin}`]);
    const ready = (
      await handoff.execute(a, { signal: new AbortController().signal, callId: ctx.callId })
    ).output as Json;
    const items = (a.items as Json[]).map((i) => ({
      name: String(i.name),
      quantity: Number(i.qty),
      unitAmount: Number(i.unitPriceMinor),
    }));
    const input: PurchaseInput = {
      merchantName: String(ready.seller),
      merchantUrl: String(ready.checkoutUrl),
      amount: Number(a.totalMinor),
      currency: String(a.currency).toLowerCase(),
      lineItems: items,
      test: true,
    };
    const payments = this.#paymentBroker();
    const spend = await payments.authorizeDispatched(
      ctx.approvalId,
      input,
      this.loopBindingHash(info, a),
    );
    const card = await payments.awaitCard(spend.spendRequestId);
    const page = new FixtureCheckout(input.merchantUrl);
    this.checkouts.push(page);
    this.#net({
      callId: ctx.callId,
      via: "browser",
      host: new URL(page.origin).host,
      url: input.merchantUrl,
      allowedBy: `approval:${ctx.approvalId}`,
    });
    for (const field of ["number", "exp", "cvc"] as CheckoutField[]) {
      page.focus(field);
      const filled = await payments.fillCard({
        cdp: page,
        spendRequestId: spend.spendRequestId,
        field,
      });
      if (!filled.ok) {
        await payments.complete(spend.spendRequestId, { outcome: "blocked", tags: ["other"] });
        throw new PsycheError("unavailable", `card fill failed (${filled.reason ?? "unknown"})`, {
          details: { reason: filled.reason ?? "fill_failed" },
        });
      }
    }
    const orderNumber = page.submit();
    if (orderNumber === null) {
      await payments.complete(spend.spendRequestId, {
        outcome: "blocked",
        tags: ["payment_declined"],
      });
      throw new PsycheError("unavailable", "the merchant did not accept the card", {
        details: { reason: "payment_declined" },
      });
    }
    const receipt = await payments.complete(spend.spendRequestId, {
      outcome: "success",
      orderNumber,
      toolCallId: ctx.callId,
      payload: { evaluator: { verdict: "verified" } },
    });
    return {
      ...ok(
        {
          status: "paid",
          seller: ready.seller,
          items: ready.items,
          total: ready.total,
          currency: ready.currency,
          paidWith: { method: "stripe_link", brand: card.card?.brand, last4: card.card?.last4 },
          orderNumber,
          linkSpendRequestId: spend.spendRequestId,
          testMode: true,
        },
        "untrusted",
      ),
      receiptId: receipt.id,
    };
  }

  /** V4: purchase cards for holding and ticketing, a destructive card for cancelling. */
  #travelDescribe(info: ToolInfo, params: Json) {
    const w = this.#flights;
    if (w === undefined) return undefined;
    switch (info.name) {
      case "travel.hold_fare":
        return holdDescription(w, params);
      case "travel.ticket_hold":
        return ticketDescription(w, params, this.bookings.get(String(params.holdRef ?? "")));
      case "travel.cancel_booking":
        return cancelDescription(w, params, this.bookings.get(String(params.confirmation ?? "")));
      default:
        return undefined;
    }
  }

  /**
   * V4 travel tools over the fixture airlines. Holding a fare authorizes the Stripe Link one-time
   * card at the airline (the vault's `hold`); ticketing captures it; cancelling inside the free
   * window refunds it. Each step is a receipt the vault's `PaymentBroker` writes.
   */
  #travelImpls(
    ok: (output: unknown, provenance?: "trusted" | "untrusted") => ToolResult,
    taint: (ctx: ToolCtx, sources: string[]) => void,
  ): Record<string, (info: ToolInfo, a: Json, ctx: ToolCtx) => Promise<ToolResult>> {
    const flights = () => {
      if (this.#flights === undefined) throw new PsycheError("unavailable", "no flight fixtures");
      return this.#flights;
    };
    const needApproval = (ctx: ToolCtx) => {
      if (ctx.approvalId === undefined)
        throw new PsycheError("approval_required", "this needs the owner's approval");
      return ctx.approvalId;
    };
    return {
      "travel.search_flights": async (_info, a, ctx) => {
        const w = flights();
        for (const al of w.fx.airlines) {
          this.#net({
            callId: ctx.callId,
            via: "connector",
            host: new URL(al.origin).host,
            url: `${al.origin}/search`,
            allowedBy: "connector:travel",
          });
        }
        taint(
          ctx,
          w.fx.airlines.map((al) => `web:${al.origin}`),
        );
        return ok({ offers: w.search(a) }, "untrusted");
      },
      "travel.hold_fare": async (info, a, ctx) => {
        const w = flights();
        const approvalId = needApproval(ctx);
        const offer = w.offer(a.offerId);
        const airline = w.airline(a.airline);
        if (offer === undefined || airline === undefined || offer.airline !== airline.id) {
          throw new PsycheError("not_found", "no such fare at that airline");
        }
        if (
          Number(a.totalMinor) !== offer.totalMinor ||
          String(a.currency).toUpperCase() !== offer.currency
        ) {
          throw new PsycheError("conflict", "the fare changed; search again", {
            details: { reason: "fare_changed" },
          });
        }
        taint(ctx, [`web:${airline.origin}`]);
        const lines = offer.segments.map(segmentLine);
        const payments = this.#paymentBroker();
        const spend = await payments.authorizeDispatched(
          approvalId,
          {
            merchantName: airline.name,
            merchantUrl: `${airline.origin}${airline.checkoutPath}`,
            amount: offer.totalMinor,
            currency: offer.currency.toLowerCase(),
            lineItems: [
              {
                name: `${lines.join(" + ")}, ${offer.cabin}`,
                quantity: 1,
                unitAmount: offer.totalMinor,
              },
            ],
            test: true,
            paymentMethodId: TEST_FUNDING.id,
          },
          this.loopBindingHash(info, a),
        );
        const card = await payments.awaitCard(spend.spendRequestId);
        const page = new FixtureCheckout(
          `${airline.origin}${airline.checkoutPath}`,
          `${airline.pnrPrefix}-HOLD`,
        );
        this.checkouts.push(page);
        this.#net({
          callId: ctx.callId,
          via: "browser",
          host: new URL(airline.origin).host,
          url: `${airline.origin}${airline.checkoutPath}`,
          allowedBy: `approval:${approvalId}`,
        });
        for (const field of ["number", "exp", "cvc"] as CheckoutField[]) {
          page.focus(field);
          const filled = await payments.fillCard({
            cdp: page,
            spendRequestId: spend.spendRequestId,
            field,
          });
          if (!filled.ok) {
            await payments.decline(spend.spendRequestId, { code: filled.reason ?? "fill_failed" });
            throw new PsycheError("unavailable", "card fill failed", {
              details: { reason: filled.reason ?? "fill_failed" },
            });
          }
        }
        const holdRef = page.submit();
        if (holdRef === null) {
          await payments.decline(spend.spendRequestId, {
            code: "card_declined",
            toolCallId: ctx.callId,
          });
          throw new PsycheError("unavailable", "the airline declined the card", {
            details: { reason: "payment_declined" },
          });
        }
        const expiresAt = new Date(this.clock.now() + airline.holdHours * 3_600_000).toISOString();
        const receipt = await payments.hold(spend.spendRequestId, {
          holdRef,
          expiresAt,
          toolCallId: ctx.callId,
          payload: { evaluator: { verdict: "verified" } },
        });
        this.bookings.set(holdRef, {
          spendRequestId: spend.spendRequestId,
          offerId: offer.offerId,
          airlineId: airline.id,
          amountMinor: offer.totalMinor,
          currency: offer.currency,
          flights: lines,
          holdRef,
        });
        return {
          ...ok(
            {
              status: "held",
              holdRef,
              holdExpiresAt: expiresAt,
              airline: airline.name,
              flights: lines,
              traveler: a.traveler,
              cabin: offer.cabin,
              fareClass: offer.fareClass,
              total: money(offer.totalMinor, offer.currency),
              charged: false,
              paidWith: {
                method: "stripe_link",
                brand: card.card?.brand,
                last4: card.card?.last4,
                fundedBy: TEST_FUNDING.last4,
              },
              linkSpendRequestId: spend.spendRequestId,
              testMode: true,
            },
            "untrusted",
          ),
          receiptId: receipt.id,
        };
      },
      "travel.ticket_hold": async (_info, a, ctx) => {
        const w = flights();
        needApproval(ctx);
        const booking = this.bookings.get(String(a.holdRef ?? ""));
        const airline = w.airline(a.airline);
        if (booking === undefined || airline === undefined || booking.airlineId !== airline.id) {
          throw new PsycheError("not_found", "no such hold at that airline");
        }
        const confirmation = `${airline.pnrPrefix}${String(7_300 + this.bookings.size).padStart(4, "0")}`;
        const receipt = await this.#paymentBroker().capture(booking.spendRequestId, {
          approvalId: ctx.approvalId,
          orderNumber: confirmation,
          merchantConfirmation: `e-ticket ${airline.pnrPrefix}-${confirmation}`,
          toolCallId: ctx.callId,
          payload: { evaluator: { verdict: "verified" } },
        });
        booking.confirmation = confirmation;
        this.bookings.set(confirmation, booking);
        return {
          ...ok(
            {
              status: "ticketed",
              confirmation,
              airline: airline.name,
              flights: booking.flights,
              charged: money(booking.amountMinor, booking.currency),
              freeCancelUntil: new Date(
                this.clock.now() + airline.freeCancelHours * 3_600_000,
              ).toISOString(),
            },
            "untrusted",
          ),
          receiptId: receipt.id,
        };
      },
      "travel.cancel_booking": async (_info, a, ctx) => {
        const w = flights();
        needApproval(ctx);
        const booking = this.bookings.get(String(a.confirmation ?? ""));
        const airline = w.airline(a.airline);
        if (booking === undefined || airline === undefined || booking.airlineId !== airline.id) {
          throw new PsycheError("not_found", "no such booking at that airline");
        }
        const refundRef = `${airline.pnrPrefix}-RF-${String(a.confirmation)}`;
        const receipt = await this.#paymentBroker().refund(booking.spendRequestId, {
          approvalId: ctx.approvalId,
          refundRef,
          reason: "cancelled within the free window",
          toolCallId: ctx.callId,
          payload: { evaluator: { verdict: "verified" } },
        });
        return {
          ...ok(
            {
              status: "cancelled",
              confirmation: a.confirmation,
              refunded: money(booking.amountMinor, booking.currency),
              refundRef,
            },
            "untrusted",
          ),
          receiptId: receipt.id,
        };
      },
    };
  }

  /** Registrations for every tool in the registry that has a fake executor. */
  tools(
    infos: ToolInfo[],
    wrap?: (name: string, run: ToolRun) => ToolRun,
    extra: Record<string, ToolImpl> = {},
  ): AgentToolRegistration[] {
    const impls = { ...this.impls(), ...extra };
    return infos.flatMap((info) => {
      const impl = impls[info.name];
      if (impl === undefined) return [];
      const base: ToolRun = (p, ctx) => impl(info, p, ctx);
      const run = wrap === undefined ? base : wrap(info.name, base);
      const reg: AgentToolRegistration = {
        spec: {
          name: info.name,
          description: `${info.name} (scenario fake)`,
          inputSchema: { type: "object" },
          sideEffect: info.sideEffect,
          provenanceOut: info.provenanceOut,
          ...(info.targetKind === null ? {} : { targetKind: info.targetKind }),
        },
        describeCall: (params) => {
          const shop = this.shopDescribe(info, params as Json);
          if (shop !== undefined) return shop;
          const target = targetOf(info, params as Json);
          const kind = info.approvalKind;
          return {
            sideEffect: info.sideEffect,
            ...(target === undefined ? {} : { target }),
            ...(kind === undefined
              ? {}
              : { kind, grantKey: `${info.name}|${target?.value ?? "*"}` }),
            summary: target === undefined ? info.name : `${info.name} ${target.value}`,
          };
        },
        execute: () => Promise.reject(new Error("runs in-process")),
        run: (params, ctx) => this.#dispatch(info, run, params as Json, ctx),
      };
      return [reg];
    });
  }

  /** The loop's recipe: kind-specific fields join the hash when the description has them. */
  loopBindingHash(info: ToolInfo, params: Json): string {
    const fields = this.shopDescribe(info, params)?.bindingFields;
    return bindingHash(info.approvalKind ?? info.name, {
      tool: info.name,
      paramsHash: paramsHash(params),
      ...(fields === undefined ? {} : { fields }),
    });
  }

  /** Fault hook → executor `bindingHash` re-check (security §3.5) → the fake provider. */
  async #dispatch(info: ToolInfo, run: ToolRun, p: Json, c: ToolCtx): Promise<ToolResult> {
    const ctx: ToolCtx = {
      callId: c.callId,
      ...(c.taskId === undefined ? {} : { taskId: c.taskId }),
      ...(c.approvalId === undefined ? {} : { approvalId: c.approvalId }),
    };
    const tamper = this.faults.get(ctx.callId);
    const params = tamper === undefined ? p : { ...p, ...tamper };
    this.faults.delete(ctx.callId);
    if (info.approvalKind !== undefined && ctx.approvalId !== undefined) {
      const approved = await this.broker().get(ctx.approvalId);
      const actual = this.loopBindingHash(info, params);
      if (approved !== undefined && approved.bindingHash !== actual) {
        // Through the broker so the mismatch is audited (`binding.mismatch`).
        await this.broker().verifyBinding(ctx.approvalId, actual);
        const output = { error: "arguments changed after approval", errorCode: "binding_mismatch" };
        this.results.push({ step: this.step, callId: ctx.callId, tool: info.name, output });
        return { output, isError: true, provenance: "trusted" };
      }
    }
    this.dispatched.add(ctx.callId);
    let result: ToolResult;
    try {
      result = await run(params, ctx);
    } catch (err) {
      const code =
        err instanceof PsycheError
          ? ((err.details as Json | undefined)?.reason ?? err.code)
          : undefined;
      const message = err instanceof Error ? err.message : String(err);
      result = {
        output: { error: message, ...(code === undefined ? {} : { errorCode: code }) },
        isError: true,
        provenance: info.provenanceOut,
      };
    }
    this.results.push({
      step: this.step,
      callId: ctx.callId,
      tool: info.name,
      output: result.output,
    });
    return result;
  }
}

function mimeOf(type: string): string {
  return type === "markdown" ? "text/markdown" : type === "pdf" ? "application/pdf" : "text/plain";
}

/** Load the fixtures a scenario names, plus the shared owner profile. */
export function loadFixtures(
  dir: string,
  files: Record<string, string>,
  ownerPath: string,
): Fixtures {
  const read = (p: string) => JSON.parse(readFileSync(join(dir, p), "utf8"));
  const fx: Fixtures = { dir, owner: read(ownerPath) };
  for (const [name, path] of Object.entries(files)) {
    if (name === "attachments") continue;
    (fx as unknown as Json)[name] = read(path);
  }
  return fx;
}
