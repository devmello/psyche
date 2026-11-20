import { type DeviceScope, PsycheError } from "@psyche/protocol";
import type { GatewayClient } from "../client.ts";
import { bool, type CommandSpec, str } from "../command.ts";
import { CliError } from "../errors.ts";
import { table } from "../output.ts";
import { callOrUnavailable, callWithApproval, splitList } from "./util.ts";

const SCOPES: readonly DeviceScope[] = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
  "node",
];
/** Least privilege by default; admin is an explicit choice (security §10). */
const DEFAULT_SCOPES: DeviceScope[] = ["operator.read", "operator.write", "operator.approvals"];

interface PairingRequest {
  id: string;
  kind: string;
  code: string;
  display: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  publicKeyFingerprint?: string;
  transport?: string;
  remoteAddress?: string;
}

function parseScopes(raw: string | undefined, admin: boolean): DeviceScope[] {
  const scopes = raw ? splitList(raw) : [...DEFAULT_SCOPES];
  for (const s of scopes) {
    if (!SCOPES.includes(s as DeviceScope)) {
      throw new CliError("usage", `Unknown scope ${s}; choose from ${SCOPES.join(", ")}`);
    }
  }
  if (admin && !scopes.includes("operator.admin")) scopes.push("operator.admin");
  return scopes as DeviceScope[];
}

async function findRequest(
  client: Awaited<ReturnType<import("../context.ts").Ctx["gateway"]>>,
  codeOrId: string,
): Promise<PairingRequest> {
  const res = (await callOrUnavailable(client, "devices.pairing.list", { status: "pending" })) as {
    pairingRequests: PairingRequest[];
  };
  const want = codeOrId.trim().toUpperCase();
  const hit = res.pairingRequests.find((r) => r.code.toUpperCase() === want || r.id === codeOrId);
  if (!hit) throw new CliError("failure", `No pending pairing request with code or id ${codeOrId}`);
  return hit;
}

interface LanStatus {
  enabled?: boolean;
  origin?: string | null;
  listening?: unknown[];
  candidates?: { name: string; address: string }[];
}

/**
 * Turns LAN listening on for one interface through the existing `gateway.lan` setting (an admin
 * setting: the Gateway enforces the scope and, once a verifier exists, fresh presence). Keeps the
 * stored port and IPv6 choice. It never names "every interface"; none given means the primary one.
 */
export async function enableLan(
  client: GatewayClient,
  iface: string | undefined,
  say: (text: string) => void,
): Promise<{ origin: string | null; interfaces: string[] }> {
  const got = (await callOrUnavailable(client, "settings.get", { keys: ["gateway.lan"] })) as {
    settings: Record<string, unknown>;
  };
  const stored = got.settings["gateway.lan"];
  const current =
    stored !== null && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const interfaces = iface
    ? [iface]
    : Array.isArray(current.interfaces)
      ? (current.interfaces as string[])
      : [];
  try {
    await callWithApproval(
      client,
      "settings.set",
      { key: "gateway.lan", value: { ...current, enabled: true, interfaces } },
      say,
    );
  } catch (err) {
    throw explain(err);
  }
  const info = (await callOrUnavailable(client, "gateway.info", {})) as { lan?: LanStatus };
  return { origin: info.lan?.origin ?? null, interfaces };
}

/**
 * Turns a refusal into the sentence a person at a terminal needs. `presence_required` is not
 * "approve first" (approvals are a tap and are waited for): it means nothing can verify now, or the
 * security records are untrusted, and each has its own recovery command on the Host.
 */
export function explain(err: unknown): unknown {
  if (err instanceof CliError) return err;
  if (err instanceof PsycheError && err.code === "presence_required") {
    const reason = (err.details as { reason?: unknown } | undefined)?.reason;
    const fix =
      reason === "no_presence_verifier"
        ? "Run `psyched presence reset` on the Host (it applies after 24 hours), or connect a device that can verify."
        : reason === "state_untrusted"
          ? "Run `psyched security reseal` on the Host (it applies after 24 hours) after reviewing your devices."
          : "Check `psyche doctor`.";
    return new CliError("failure", `${err.message} ${fix}`);
  }
  return err;
}

export const devicesCommands: CommandSpec[] = [
  {
    path: ["pairing", "list"],
    summary: "List pairing requests (pending by default)",
    options: {
      status: {
        type: "string",
        description: "pending | approved | denied | expired | all",
        choices: ["pending", "approved", "denied", "expired", "all"],
      },
    },
    async run(ctx, { opts }) {
      const status = str(opts, "status") ?? "pending";
      const client = await ctx.gateway();
      const res = (await callOrUnavailable(
        client,
        "devices.pairing.list",
        status === "all" ? {} : { status },
      )) as { pairingRequests: PairingRequest[] };
      return {
        data: res,
        human: table(res.pairingRequests as never, {
          code: "code",
          kind: "kind",
          display: "display",
          status: "status",
          fingerprint: "publicKeyFingerprint",
          from: "remoteAddress",
          expires: "expiresAt",
        }),
      };
    },
  },
  {
    path: ["pairing", "approve"],
    summary: "Approve a pending device by its code, with owner-chosen scopes",
    description:
      "Scopes default to operator.read,operator.write,operator.approvals. Check the key fingerprint against the one the device shows before approving.",
    args: [{ name: "code", description: "Pairing code or request id", required: true }],
    options: {
      scopes: { type: "string", description: "Comma-separated scopes" },
      admin: { type: "boolean", description: "Also grant operator.admin" },
    },
    async run(ctx, { args, opts }) {
      const scopes = parseScopes(str(opts, "scopes"), bool(opts, "admin"));
      const client = await ctx.gateway();
      const req = await findRequest(client, args[0] as string);
      const res = (await callOrUnavailable(client, "devices.approve", {
        pairingRequestId: req.id,
        scopes,
        code: req.code,
      })) as { device: { id: string; name: string; scopes: string[] } };
      return {
        data: res,
        human: `Approved ${res.device.name} (${res.device.id}) with ${res.device.scopes.join(", ")}`,
      };
    },
  },
  {
    path: ["pairing", "deny"],
    summary: "Deny a pending pairing request",
    args: [{ name: "code", description: "Pairing code or request id", required: true }],
    options: { reason: { type: "string", description: "Reason recorded with the denial" } },
    async run(ctx, { args, opts }) {
      const client = await ctx.gateway();
      const req = await findRequest(client, args[0] as string);
      const reason = str(opts, "reason");
      const res = await callOrUnavailable(client, "devices.deny", {
        pairingRequestId: req.id,
        ...(reason ? { reason } : {}),
      });
      return { data: res, human: `Denied pairing request ${req.code} (${req.display})` };
    },
  },
  {
    path: ["devices", "list"],
    summary: "List paired devices and their scopes",
    options: { all: { type: "boolean", description: "Include revoked devices" } },
    async run(ctx, { opts }) {
      const client = await ctx.gateway();
      const res = (await callOrUnavailable(client, "devices.list", {
        includeRevoked: bool(opts, "all"),
      })) as { devices: Record<string, unknown>[] };
      const rows = res.devices.map((d) => ({ ...d, self: d.id === client.deviceId ? "*" : "" }));
      return {
        data: res,
        human: table(rows, {
          id: "id",
          name: "name",
          platform: "platform",
          role: "role",
          scopes: "scopes",
          "last seen": "lastSeenAt",
          revoked: "revokedAt",
          self: "self",
        }),
      };
    },
  },
  {
    path: ["devices", "revoke"],
    summary: "Revoke a device permanently (token and node authority)",
    args: [{ name: "deviceId", description: "Device id", required: true }],
    options: { yes: { type: "boolean", short: "y", description: "Do not ask for confirmation" } },
    async run(ctx, { args, opts }) {
      const deviceId = args[0] as string;
      if (!bool(opts, "yes")) {
        if (!ctx.deps.prompter.interactive) {
          throw new CliError(
            "usage",
            "Revoking is permanent; pass --yes to confirm non-interactively",
          );
        }
        if (!(await ctx.deps.prompter.confirm(`Revoke ${deviceId} permanently?`))) {
          return { data: { revoked: false }, human: "Cancelled", exitCode: 1 };
        }
      }
      const client = await ctx.gateway();
      const res = await callOrUnavailable(client, "devices.revoke", { deviceId });
      return { data: res, human: `Revoked ${deviceId}` };
    },
  },
  {
    path: ["devices", "link"],
    summary: "Make a single-use pairing link for another computer (admin CLI on this Host only)",
    description:
      "Prints a psyche-pair link, valid for 10 minutes and usable once; at most three are live at a time. Without --lan it is a v1 link for gateway.publicOrigin; --lan makes a v2 link for this network (turn LAN on first: `psyche lan on`). Scopes default to operator.read,operator.write,operator.approvals; --admin adds operator.admin. Only the admin CLI on the Host itself (it proves that by reading $PSYCHE_HOME/run/handshake.secret) may make one.",
    options: {
      admin: {
        type: "boolean",
        description: "Also grant operator.admin to the computer that pairs",
      },
      lan: { type: "boolean", description: "A link for this network (v2), not the public address" },
      scopes: { type: "string", description: "Comma-separated scopes" },
    },
    async run(ctx, { opts }) {
      const scopes = parseScopes(str(opts, "scopes"), bool(opts, "admin"));
      const client = await ctx.gateway();
      let made: {
        link: string;
        version: number;
        gatewayUrl: string;
        setupToken: { id: string; expiresAt: string; scopes: string[] };
      };
      try {
        made = (await callWithApproval(
          client,
          "devices.setupToken.create",
          { scopes, ...(bool(opts, "lan") ? { via: "lan" } : {}) },
          (t) => ctx.deps.io.err(t),
        )) as typeof made;
      } catch (err) {
        if (err instanceof PsycheError && err.code === "forbidden") {
          throw new CliError(
            "failure",
            "Only the admin CLI on the Host's own computer can make a pairing link: run it on the Host itself, as a device with operator.admin (`psyched devices grant <deviceId> operator.read,operator.write,operator.approvals,operator.admin` on the Host), and make sure this CLI can read $PSYCHE_HOME/run/handshake.secret.",
          );
        }
        throw explain(err);
      }
      return {
        data: made,
        human: [
          made.link,
          "",
          `Open this on the other computer in Psyche (v${made.version} link for ${made.gatewayUrl}).`,
          `Single use; expires ${made.setupToken.expiresAt}. Grants ${made.setupToken.scopes.join(", ")}.`,
          "Anyone holding it can pair until then: do not paste it anywhere shared.",
        ].join("\n"),
      };
    },
  },
  {
    path: ["lan", "on"],
    summary: "Allow computers on this network to connect (gateway.lan), on one interface",
    description:
      "Admin only. Names one interface or address (never every interface); with none given, the primary interface. Then make a link for this network with `psyche devices link --lan`.",
    options: {
      interface: { type: "string", description: "Interface name or address (en0, eth0)" },
    },
    async run(ctx, { opts }) {
      const client = await ctx.gateway();
      const res = await enableLan(client, str(opts, "interface"), (t) => ctx.deps.io.err(t));
      return {
        data: { enabled: true, ...res },
        human: res.origin
          ? `LAN is on at ${res.origin}`
          : "LAN is on, but nothing is listening yet; check `psyche doctor`",
      };
    },
  },
];
