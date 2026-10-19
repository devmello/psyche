import type { DeviceScope } from "@psyche/protocol";
import { bool, type CommandSpec, str } from "../command.ts";
import { CliError } from "../errors.ts";
import { table } from "../output.ts";
import { callOrUnavailable, splitList } from "./util.ts";

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
];
