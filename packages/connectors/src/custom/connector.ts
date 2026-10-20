import {
  type CustomConnectorManifest,
  type CustomConnectorTool,
  PsycheError,
  type ResolvedSecret,
  type Target,
  type ToolCallDescription,
} from "@psyche/protocol";
import { canonicalJSON, sha256 } from "../framework/binding.ts";
import { asObject } from "../framework/params.ts";
import type {
  ActionRule,
  CatalogueEntry,
  ConnectInput,
  Connector,
  ConnectorAction,
  ConnectorContext,
  ConnectorFactory,
  ConnectorHealth,
  ConnectorRecord,
  ConnectorTool,
  ConnectResult,
  ToolOutput,
  ToolRunContext,
} from "../framework/types.ts";
import { type DnsLookup, vetUrl } from "../web/fetch.ts";
import { assertManifest, manifestHash } from "./manifest.ts";

/**
 * The executor for custom connectors (feature M9): each manifest tool becomes one HTTPS request
 * to the manifest's `baseUrl`. No code from the manifest runs. Requests reach only allowlisted
 * hosts (redirects included) after the SSRF vetting `web_fetch` uses; the vault credential is
 * resolved per call and attached only for `baseUrl`'s host, never on a redirect elsewhere;
 * responses are capped, passed through the vault redactor and returned as untrusted data.
 */

export const CUSTOM_RESPONSE_MAX_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

export const CUSTOM_CATALOGUE: CatalogueEntry = {
  type: "custom",
  id: "custom",
  label: "Custom connector",
  description:
    "A REST API you describe (or import from OpenAPI), reviewed on a trust card before it runs.",
  category: "community",
  vendor: "You",
  auth: "api_key",
  scopes: { read: ["custom.read"], read_act: ["custom.read", "custom.write"] },
  actions: [],
  setupGuide: "packages/connectors/README.md#custom-connectors-m9",
  available: true,
};

/** Matrix rows: one per tool, `custom.<tool>`, default by tier unless the manifest says stricter. */
export function customActions(m: CustomConnectorManifest): ConnectorAction[] {
  return m.tools.map((t) => {
    const tierDefault: ActionRule = t.sideEffect === "read" ? "allow" : "ask";
    const rule = t.defaultRule ?? tierDefault;
    return {
      id: `custom.${t.name}`,
      title: t.description.split(/[.\n]/)[0]?.slice(0, 80) || t.name,
      sideEffect: t.sideEffect,
      ...(t.sideEffect === "read" ? {} : { approvalKind: "connector_action" as const }),
      // Writes and destructive calls never start as allow.
      defaultRule: t.sideEffect !== "read" && rule === "allow" ? "ask" : rule,
    };
  });
}

export type ApproveCustomCredential = (
  request: { connectorId: string; placeholder: string; target: Target },
  run: ToolRunContext,
) => Promise<string>;

export interface CustomFactoryOptions {
  /** A live `credential_fill` grant id for the connector's credential (the Gateway's). */
  approveCredential?: ApproveCustomCredential;
  lookup?: DnsLookup;
}

function inputSchema(t: CustomConnectorTool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const p of t.params)
    properties[p.name] = {
      ...p.schema,
      ...(p.description === undefined ? {} : { description: p.description }),
    };
  return {
    type: "object",
    properties,
    required: t.params.filter((p) => p.required === true).map((p) => p.name),
    additionalProperties: false,
  };
}

function encodeValue(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

export class CustomConnector implements Connector {
  readonly id: string;
  readonly type = "custom";
  readonly #ctx: ConnectorContext;
  readonly #opts: CustomFactoryOptions;
  readonly #manifest: CustomConnectorManifest;
  readonly #hash: string;
  readonly #base: URL;
  #status: ConnectorRecord["status"];

  constructor(record: ConnectorRecord, ctx: ConnectorContext, options: CustomFactoryOptions) {
    this.id = record.id;
    this.#ctx = ctx;
    this.#opts = options;
    const cfg = record.config as { manifest?: unknown; hash?: unknown };
    this.#manifest = assertManifest(cfg.manifest);
    this.#hash = manifestHash(this.#manifest);
    // The record carries the hash the owner approved: a manifest edited behind it never runs.
    if (cfg.hash !== this.#hash)
      throw new PsycheError(
        "conflict",
        "the custom connector manifest changed since it was approved",
      );
    this.#base = new URL(this.#manifest.baseUrl);
    this.#status = record.status;
  }

  get manifest(): CustomConnectorManifest {
    return structuredClone(this.#manifest);
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    this.#status = "connected";
    return {
      account: this.#base.hostname,
      scopes: CUSTOM_CATALOGUE.scopes[input.scopeMode],
    };
  }

  async disconnect(): Promise<void> {
    this.#status = "disconnected";
  }

  actions(): ConnectorAction[] {
    return customActions(this.#manifest);
  }

  async health(): Promise<ConnectorHealth> {
    return {
      ok: this.#status === "connected",
      status: this.#status,
      checkedAt: this.#ctx.clock.now(),
    };
  }

  tools(): ConnectorTool[] {
    return this.#manifest.tools.map((t) => ({
      name: t.name,
      action: `custom.${t.name}`,
      // The owner reviewed this text on the trust card; it is still the API author's words.
      description: `${t.description} [${t.method} ${this.#base.hostname}; from custom connector "${this.#manifest.name}"]`,
      inputSchema: inputSchema(t),
      sideEffect: t.sideEffect,
      ...(t.sideEffect === "read" ? {} : { describeCall: (p: unknown) => this.#describe(t, p) }),
      execute: (p, run) => this.#call(t, p, run),
    }));
  }

  #describe(t: CustomConnectorTool, params: unknown): ToolCallDescription {
    return {
      kind: "connector_action",
      target: { kind: "origin", value: this.#base.origin, display: this.#manifest.name },
      bindingFields: {
        connectorId: this.id,
        tool: t.name,
        manifestHash: this.#hash,
        request: `${t.method} ${this.#base.hostname}${this.#base.pathname.replace(/\/$/, "")}${t.path}`,
        paramsHash: sha256(canonicalJSON(params ?? {})),
      },
      grantKey: `connector_action:${this.id}:${t.name}:${this.#hash}`,
      summary: `${t.method} ${t.path} on ${this.#manifest.name}`,
    };
  }

  #url(
    t: CustomConnectorTool,
    params: Record<string, unknown>,
  ): { url: URL; body: Record<string, unknown> | undefined } {
    let path = t.path;
    const body: Record<string, unknown> = {};
    const query = new URLSearchParams();
    for (const p of t.params) {
      const v = params[p.name];
      if (v === undefined || v === null) {
        if (p.required === true) throw new PsycheError("invalid_params", `${p.name} is required`);
        continue;
      }
      if (p.in === "path") {
        const s = encodeValue(v);
        if (s === "" || s === "." || s === "..")
          throw new PsycheError("invalid_params", `${p.name} is not a valid path segment`);
        path = path.replace(`{${p.name}}`, encodeURIComponent(s));
      } else if (p.in === "query") {
        if (Array.isArray(v)) for (const x of v) query.append(p.name, encodeValue(x));
        else query.set(p.name, encodeValue(v));
      } else body[p.name] = v;
    }
    for (const k of Object.keys(params)) {
      if (!t.params.some((p) => p.name === k))
        throw new PsycheError("invalid_params", `unknown parameter ${k}`);
    }
    const url = new URL(`${this.#base.origin}${this.#base.pathname.replace(/\/$/, "")}${path}`);
    // Encoded segments can never climb out of baseUrl's path.
    if (!url.pathname.startsWith(this.#base.pathname.replace(/\/$/, ""))) {
      throw new PsycheError("invalid_params", "the request path leaves the connector's base URL");
    }
    for (const [k, v] of query) url.searchParams.append(k, v);
    return { url, body: Object.keys(body).length > 0 ? body : undefined };
  }

  async #secret(run: ToolRunContext): Promise<ResolvedSecret | undefined> {
    const auth = this.#manifest.auth;
    if (auth.kind === "none") return undefined;
    const credentials = this.#ctx.credentials;
    if (credentials === undefined)
      throw new PsycheError("unavailable", "no credential broker for the connector's key");
    const target: Target = { kind: "origin", value: this.#base.origin };
    const approvalId =
      this.#opts.approveCredential === undefined
        ? run.approvalId
        : await this.#opts.approveCredential(
            { connectorId: this.id, placeholder: auth.credential, target },
            run,
          );
    if (approvalId === undefined)
      throw new PsycheError(
        "approval_required",
        "the connector's credential needs an approved fill",
      );
    return credentials.resolve(auth.credential, target, approvalId, {
      executor: "connector",
      signal: run.signal,
    });
  }

  async #call(t: CustomConnectorTool, raw: unknown, run: ToolRunContext): Promise<ToolOutput> {
    const params = asObject(raw ?? {});
    let { url, body } = this.#url(t, params);
    const secret = await this.#secret(run);
    let value: string | undefined;
    try {
      value = secret?.use((v) => v);
    } finally {
      secret?.dispose();
    }
    const auth = this.#manifest.auth;
    let method: string = t.method;
    for (let hop = 0; ; hop++) {
      if (!this.#manifest.hosts.includes(url.hostname) || url.protocol !== "https:") {
        throw new PsycheError("policy_denied", `${url.host} is not one of the connector's hosts`, {
          details: { reason: "host_not_allowlisted", host: url.host },
        });
      }
      await vetUrl(url, {
        signal: run.signal,
        ...(this.#opts.lookup === undefined ? {} : { lookup: this.#opts.lookup }),
      });
      const headers = new Headers({
        accept: "application/json, text/plain;q=0.8, */*;q=0.1",
        "user-agent": "Psyche",
      });
      const sendCredential = value !== undefined && url.host === this.#base.host;
      const target = new URL(url);
      if (sendCredential) {
        if (auth.kind === "bearer") headers.set("authorization", `Bearer ${value}`);
        else if (auth.kind === "header") headers.set(auth.name, value as string);
        else if (auth.kind === "query") target.searchParams.set(auth.name, value as string);
        else if (auth.kind === "basic")
          headers.set("authorization", `Basic ${Buffer.from(value as string).toString("base64")}`);
      }
      if (body !== undefined) headers.set("content-type", "application/json");
      const res = await this.#ctx.fetch(target, {
        method,
        headers,
        redirect: "manual",
        signal: run.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location !== null) {
        if (hop >= MAX_REDIRECTS) throw new PsycheError("unavailable", "too many redirects");
        url = new URL(location, url);
        // 303 (and 301/302 for POST, as browsers do) continue as GET without a body.
        if (
          res.status === 303 ||
          ((res.status === 301 || res.status === 302) && method !== "GET")
        ) {
          method = "GET";
          body = undefined;
        }
        continue;
      }
      return this.#output(t, res);
    }
  }

  async #output(t: CustomConnectorTool, res: Response): Promise<ToolOutput> {
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > CUSTOM_RESPONSE_MAX_BYTES) {
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
      }
    }
    const redact = (s: string) => this.#ctx.credentials?.redact(s) ?? s;
    const text = redact(Buffer.concat(chunks).toString("utf8"));
    let parsed: unknown = text;
    if ((res.headers.get("content-type") ?? "").includes("json") && !truncated) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const out: ToolOutput = {
      output: { status: res.status, body: parsed, ...(truncated ? { truncated: true } : {}) },
      provenance: "untrusted",
      externalRefs: { status: res.status },
      receiptSummary: `${t.method} ${t.path} on ${this.#manifest.name}: HTTP ${res.status}`,
    };
    if (res.status >= 400) out.isError = true;
    return out;
  }
}

export function customFactory(options: CustomFactoryOptions = {}): ConnectorFactory {
  return {
    entry: CUSTOM_CATALOGUE,
    create: (record, ctx) => new CustomConnector(record, ctx, options),
  };
}
