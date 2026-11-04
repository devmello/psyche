import { createInterface } from "node:readline";
import { Methods } from "@psyche/protocol";
import { startSkeleton } from "../walking-skeleton/harness.ts";
import { MAIN, ScriptedModel, say, UTILITY } from "../walking-skeleton/scripted-model.ts";

/**
 * A real Gateway for the iOS app's integration test (`apps/ios/Tests/PsycheClientTests/LiveGatewayTests.swift`):
 * the walking-skeleton rig (composed `psyched`, temporary `$PSYCHE_HOME`, scripted model) listening on
 * loopback. It prints one JSON line when ready, then reads commands on stdin:
 *
 *   approve  approve the newest pending device with read, write and approvals (the owner, on the Mac)
 *   stop     shut down (so does closing stdin)
 *
 * Run: `node tests/integration/ios-gateway/serve.ts`.
 */

const emit = (value: string): void => {
  process.stdout.write(`${value}\n`);
};

const REPLY = "Hello from the scripted Gateway.";
const model = new ScriptedModel();
model.chat.script([say(REPLY), say(REPLY)]);

const sk = await startSkeleton({
  model: { provider: model, model: MAIN, utilityModel: UTILITY },
  timeZone: "America/Los_Angeles",
});
const origin = sk.composed.gateway.origin;
// The desktop shell makes itself the first admin (devices.bootstrapAdmin); reconnect to carry the scope.
await sk.client.call("devices.bootstrapAdmin", {}, true);
const admin = await sk.connect();
const info = await admin.call<{ identity: { publicKey: string; fingerprint: string } }>(
  "gateway.info",
);

// A pairing link. With `devices.pairing.createLink` (remote Gateway R2) it is a real one; without it
// the link is built here with a placeholder token, which a Gateway that predates setup tokens ignores.
const bytes = (start: number): string =>
  Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => start + i)).toString("base64url");
let link: string;
let realLink = false;
if ("devices.pairing.createLink" in Methods) {
  const made = await admin.call<{ link: string }>(
    "devices.pairing.createLink",
    { gatewayUrl: origin },
    true,
  );
  link = made.link;
  realLink = true;
} else {
  const json = JSON.stringify({
    gatewayUrl: origin,
    gatewayIdentityKey: info.identity.publicKey,
    setupToken: bytes(0),
    hostName: "ios-test-host",
  });
  link = `psyche-pair:v1:${Buffer.from(json).toString("base64url")}`;
}

emit(
  JSON.stringify({
    ready: true,
    origin,
    identityKey: info.identity.publicKey,
    fingerprint: info.identity.fingerprint,
    reply: REPLY,
    link,
    realLink,
  }),
);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await sk.stop();
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  try {
    await handle(line.trim());
  } catch (error) {
    emit(JSON.stringify({ error: String(error) }));
  }
});

async function handle(command: string): Promise<void> {
  if (command === "stop") {
    await stop();
  } else if (command === "approve") {
    const { pairingRequests } = await admin.call<{
      pairingRequests: { id: string; kind: string }[];
    }>("devices.pairing.list", {});
    const request = pairingRequests.filter((r) => r.kind === "device").at(-1);
    if (!request) {
      emit(JSON.stringify({ approved: false, reason: "no pending request" }));
      return;
    }
    await admin.call("devices.approve", {
      pairingRequestId: request.id,
      scopes: ["operator.read", "operator.write", "operator.approvals"],
    });
    emit(JSON.stringify({ approved: true }));
  }
}
lines.on("close", () => void stop());
