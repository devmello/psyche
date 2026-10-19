import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ComposedGateway, type ComposeOptions, composeGateway } from "@psyche/gateway/compose";
import { PROTOCOL_VERSION } from "@psyche/protocol";
import { GatewayConnection } from "@psyche/web/client";
import { Client } from "../walking-skeleton/harness.ts";

/**
 * The walking-skeleton rig (../walking-skeleton/harness.ts) with INT-2 parts mounted: a composed
 * `psyched` in a temporary `$PSYCHE_HOME`, driven by the desktop's own Gateway client paired over
 * loopback. Log lines are kept so the scenario can check them for secrets.
 */

export interface PartsSkeleton {
  composed: ComposedGateway;
  home: string;
  client: Client;
  logs: string[];
  stop(): Promise<void>;
}

export async function startWithParts(
  options: Pick<ComposeOptions, "model" | "clock" | "timeZone" | "parts" | "policy">,
): Promise<PartsSkeleton> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "psyche-int2-")));
  const logs: string[] = [];
  const composed = await composeGateway({
    background: false,
    ...options,
    env: {},
    logger: { log: (level, msg, fields) => logs.push(JSON.stringify({ level, msg, ...fields })) },
    retentionIntervalMs: 0,
    config: { home, port: 0, dbPath: join(home, "psyche.db"), webRoot: null },
  });
  const { gateway } = composed;
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKey = String(privateKey.export({ format: "jwk" }).x);
  const deviceId = `dev_${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("base64url").slice(0, 22)}`;
  const client = new Client(
    (onStatus, onEvent) =>
      new GatewayConnection({
        wsUrl: `ws://127.0.0.1:${gateway.port}/ws`,
        healthUrl: `${gateway.origin}/healthz`,
        connectParams: () => ({
          protocolVersion: { min: 1, max: PROTOCOL_VERSION },
          deviceId,
          publicKey,
          role: "client",
          platform: "macos",
          deviceFamily: "desktop",
          name: "INT-2 desktop",
          handshakeSecret: gateway.handshakeSecret,
        }),
        sign: (payload) => sign(null, payload, privateKey).toString("base64url"),
        onStatus,
        onEvent,
      }),
  );
  client.start();
  await client.until(() => client.status?.phase === "paired", "pairing");
  return {
    composed,
    home,
    client,
    logs,
    async stop() {
      client.stop();
      await composed.stop("test");
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** What the approval card does on "Allow once" / "Deny": this surface's token, arming delay, answer. */
export async function answer(
  client: Client,
  approvalId: string,
  decision: "approve" | "deny",
): Promise<void> {
  const { answerToken } = await client.call<{ answerToken?: string }>("approvals.get", {
    approvalId,
  });
  if (answerToken === undefined) throw new Error(`no answer token for ${approvalId}`);
  // The card arms after a short delay (docs/06 approval card); an earlier answer is refused.
  await new Promise((r) => setTimeout(r, 600));
  await client.call("approvals.answer", {
    approvalId,
    answerToken,
    decision,
    ...(decision === "approve" ? { scope: "once" } : {}),
  });
}
