import { type Static, Type } from "@sinclair/typebox";
import { IsoDateTime, Nullable, StringEnum } from "./common.ts";
import { PsycheError } from "./errors.ts";
import { BrowserController, BrowserProfile } from "./methods/browser.ts";
import {
  createValidator,
  defineEvent,
  defineMethod,
  type EventSpec,
  type MethodSpec,
  OkResult,
} from "./methods/define.ts";

/**
 * Browser bridge protocol (architecture §5, §8; wire spec v1): the desktop shell exposes its
 * embedded `WebContentsView` tabs to the Gateway's CDP driver over
 * `$PSYCHE_HOME/run/browser-bridge.sock` (mode 0600), with the same NDJSON framing and
 * `req` / `res` / `event` frames as the node socket and every method prefixed `bridge.`.
 *
 * Directions:
 * - desktop → Gateway: `req bridge.hello` first (carries the per-launch handshake secret).
 * - Gateway → desktop: every other `bridge.*` method (tab lifecycle, attach/detach, CDP send).
 * - desktop → Gateway events: `bridge.cdp.event`, `bridge.tab.*`, `bridge.control.changed`,
 *   `bridge.download`. On this socket `seq` counts per connection and `stateVersion` is 0.
 *
 * Security: the bridge only forwards CDP; it adds no way to run page JavaScript beyond what CDP
 * forwarding already implies. The Gateway's `BrowserDriver` is the policy point: it enforces
 * the task's origin policy (read-only vs read-writable origins, allowlists on redirects, blocked
 * `about:` / `chrome:` / `file:`), must never send `Runtime.evaluate`-style page scripts against
 * third-party sites (architecture §8), and quarantines downloads. The desktop additionally
 * refuses CDP sessions on its own UI and on tabs not created through the bridge.
 */

/** Same vocabulary as `browser.*`: `logged-in` profile or a `clean` logged-out partition. */
export const BridgeProfile = BrowserProfile;
export type BridgeProfile = BrowserProfile;

/** Take-control state of a tab: `agent`, `user` (the user is driving) or `paused`. */
export const BridgeControlState = BrowserController;
export type BridgeControlState = BrowserController;

const TabId = Type.String({ minLength: 1, maxLength: 128, $id: "BridgeTabId" });
const CdpSessionId = Type.String({ minLength: 1, maxLength: 128 });
/** CDP method name, `Domain.method`. */
const CdpMethod = Type.String({ pattern: "^[A-Z][A-Za-z]*\\.[A-Za-z]+$", maxLength: 128 });

export const BridgeTab = Type.Object(
  {
    tabId: TabId,
    url: Type.String(),
    title: Type.String(),
    partition: Type.String({ description: "Electron session partition, e.g. persist:psyche" }),
    profile: BridgeProfile,
    attached: Type.Boolean({ description: "A CDP debugger session is attached" }),
  },
  { $id: "BridgeTab" },
);
export type BridgeTab = Static<typeof BridgeTab>;

export const BridgeHelloParams = Type.Object(
  {
    protocolVersion: Type.Integer({ minimum: 1 }),
    handshakeSecret: Type.String({ minLength: 1, maxLength: 256 }),
    desktopVersion: Type.String({ minLength: 1 }),
  },
  { $id: "BridgeHelloParams" },
);

export const BridgeCdpSendParams = Type.Object(
  {
    tabId: TabId,
    sessionId: Type.Optional(CdpSessionId),
    method: CdpMethod,
    params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { $id: "BridgeCdpSendParams" },
);
export type BridgeCdpSendParams = Static<typeof BridgeCdpSendParams>;

const TabIdParams = Type.Object({ tabId: TabId }, { $id: "BridgeTabIdParams" });
const BridgeTabResult = Type.Object({ tab: BridgeTab }, { $id: "BridgeTabResult" });

export const BridgeMethods = {
  "bridge.hello": defineMethod({
    params: BridgeHelloParams,
    result: Type.Object({
      protocolVersion: Type.Integer({ minimum: 1 }),
      gatewayVersion: Type.String(),
    }),
    scope: "none",
    description:
      "desktop → Gateway, first frame: authenticates with the per-launch handshake secret (the socket is 0600 as well).",
  }),
  "bridge.tabs.list": defineMethod({
    params: Type.Object({}),
    result: Type.Object({ tabs: Type.Array(BridgeTab) }),
    scope: "none",
    description: "Gateway → desktop: lists bridge tabs.",
  }),
  "bridge.tab.open": defineMethod({
    params: Type.Object({
      url: Type.String({ pattern: "^https?://", maxLength: 8192 }),
      profile: Type.Optional(BridgeProfile),
      background: Type.Optional(Type.Boolean()),
    }),
    result: BridgeTabResult,
    scope: "none",
    description: "Gateway → desktop: opens a tab (http and https only).",
  }),
  "bridge.tab.close": defineMethod({
    params: TabIdParams,
    result: OkResult,
    scope: "none",
    description: "Gateway → desktop: closes a tab.",
  }),
  "bridge.attach": defineMethod({
    params: TabIdParams,
    result: BridgeTabResult,
    scope: "none",
    description: "Gateway → desktop: attaches a CDP debugger session to a tab.",
  }),
  "bridge.detach": defineMethod({
    params: TabIdParams,
    result: OkResult,
    scope: "none",
    description: "Gateway → desktop: detaches the CDP session.",
  }),
  "bridge.cdp.send": defineMethod({
    params: BridgeCdpSendParams,
    result: Type.Object({ result: Type.Unknown() }),
    scope: "none",
    description:
      "Gateway → desktop: forwards one CDP command to an attached tab. Origin policy is enforced by the Gateway's BrowserDriver before sending.",
  }),
} as const;

export const BridgeEvents = {
  "bridge.cdp.event": defineEvent({
    payload: Type.Object({
      tabId: TabId,
      sessionId: Type.Optional(CdpSessionId),
      method: CdpMethod,
      params: Type.Unknown(),
    }),
    description: "desktop → Gateway: a CDP event from an attached tab.",
  }),
  "bridge.tab.created": defineEvent({
    payload: BridgeTabResult,
    description: "desktop → Gateway: a tab was created.",
  }),
  "bridge.tab.updated": defineEvent({
    payload: BridgeTabResult,
    description: "desktop → Gateway: a tab's URL, title or attachment changed.",
  }),
  "bridge.tab.closed": defineEvent({
    payload: TabIdParams,
    description: "desktop → Gateway: a tab was closed.",
  }),
  "bridge.control.changed": defineEvent({
    payload: Type.Object({ tabId: TabId, state: BridgeControlState }),
    description:
      "desktop → Gateway: Take control. While the state is user or paused the agent's input is held; it resumes on release.",
  }),
  "bridge.download": defineEvent({
    payload: Type.Object({
      tabId: TabId,
      downloadId: Type.String({ minLength: 1 }),
      url: Type.String(),
      filename: Type.String(),
      mime: Nullable(Type.String()),
      state: StringEnum(["started", "completed", "failed", "cancelled"], {
        $id: "BridgeDownloadState",
      }),
      bytes: Nullable(Type.Integer({ minimum: 0 })),
      quarantinePath: Nullable(
        Type.String({ description: "Where the file landed; quarantined until scanned" }),
      ),
      at: IsoDateTime,
    }),
    description: "desktop → Gateway: download progress; files land in quarantine.",
  }),
} as const;

export type BridgeMethodName = keyof typeof BridgeMethods;
export type BridgeMethodParams<M extends BridgeMethodName> = Static<
  (typeof BridgeMethods)[M]["params"]
>;
export type BridgeMethodResult<M extends BridgeMethodName> = Static<
  (typeof BridgeMethods)[M]["result"]
>;
export type BridgeEventName = keyof typeof BridgeEvents;
export type BridgeEventPayload<E extends BridgeEventName> = Static<
  (typeof BridgeEvents)[E]["payload"]
>;

const bridgeMethodTable: Readonly<Record<string, MethodSpec>> = BridgeMethods;
const bridgeEventTable: Readonly<Record<string, EventSpec>> = BridgeEvents;
const bridgeValidators = new Map<string, ReturnType<typeof createValidator>>();

function bridgeCheck(
  key: string,
  schema: MethodSpec["params"],
  value: unknown,
  what: string,
): unknown {
  let v = bridgeValidators.get(key);
  if (v === undefined) {
    v = createValidator(schema);
    bridgeValidators.set(key, v);
  }
  if (v.check(value)) return value;
  const errors = v.errors(value);
  throw new PsycheError("invalid_params", `invalid ${what}: ${errors.join("; ")}`, {
    details: { errors },
  });
}

/** Validates `bridge.*` method params (absent params count as `{}`). */
export function validateBridgeParams<M extends BridgeMethodName>(
  method: M,
  params: unknown,
): BridgeMethodParams<M>;
export function validateBridgeParams(method: string, params: unknown): unknown;
export function validateBridgeParams(method: string, params: unknown): unknown {
  const spec = Object.hasOwn(bridgeMethodTable, method) ? bridgeMethodTable[method] : undefined;
  if (spec === undefined)
    throw new PsycheError("unknown_method", `unknown bridge method ${JSON.stringify(method)}`);
  return bridgeCheck(
    `m:${method}`,
    spec.params,
    params === undefined ? {} : params,
    `params for ${method}`,
  );
}

/** Validates a `bridge.*` event payload. */
export function validateBridgeEventPayload<E extends BridgeEventName>(
  event: E,
  payload: unknown,
): BridgeEventPayload<E>;
export function validateBridgeEventPayload(event: string, payload: unknown): unknown;
export function validateBridgeEventPayload(event: string, payload: unknown): unknown {
  const spec = Object.hasOwn(bridgeEventTable, event) ? bridgeEventTable[event] : undefined;
  if (spec === undefined)
    throw new PsycheError("invalid_params", `unknown bridge event ${JSON.stringify(event)}`);
  return bridgeCheck(`e:${event}`, spec.payload, payload, `payload for ${event}`);
}
