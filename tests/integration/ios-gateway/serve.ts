import { createInterface } from "node:readline";
import { createSetupToken, insertDevice } from "@psyche/db";
import { startSkeleton } from "../walking-skeleton/harness.ts";
import { MAIN, ScriptedModel, say, UTILITY } from "../walking-skeleton/scripted-model.ts";

/**
 * A real Gateway for the iOS app's integration test (`apps/ios/Tests/PsycheClientTests/LiveGatewayTests.swift`):
 * the walking-skeleton rig (composed `psyched`, temporary `$PSYCHE_HOME`, scripted model) listening on
 * loopback. It prints one JSON line when ready, then reads commands on stdin:
 *
 *   enroll <deviceId> <publicKey>  the owner pairs this phone (read, write, approvals), as approving it on the Mac does
 *   tokens   print the status of every setup token made (`live`, `used`, ...), never the token
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

// A real one-time setup token, minted the way `devices.setupToken.create` does. That method refuses a Gateway
// with no public origin (this one listens on loopback), and main's pairing links name an https origin that is
// never loopback, so the phone's test builds its link from these parts and dials the loopback origin.
const mint = (): string =>
  createSetupToken(sk.composed.db, {
    scopes: ["operator.read", "operator.write", "operator.approvals"],
  }).token;

emit(
  JSON.stringify({
    ready: true,
    origin,
    identityKey: info.identity.publicKey,
    fingerprint: info.identity.fingerprint,
    reply: REPLY,
    setupToken: mint(),
    spareSetupToken: mint(),
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
  const [verb, deviceId, publicKey] = command.split(" ");
  if (verb === "stop") {
    await stop();
  } else if (verb === "enroll" && deviceId && publicKey) {
    // The Gateway takes a setup token from a new device only when it is the desktop app (auth.ts, "the phone
    // comes later"), so the phone is paired the way an owner's approval pairs it, then presents its link.
    insertDevice(sk.composed.db, {
      id: deviceId,
      name: "Test iPhone",
      platform: "ios",
      role: "client",
      publicKey,
      scopes: ["operator.read", "operator.write", "operator.approvals"],
      pairedAt: new Date().toISOString(),
      deviceFamily: "ios",
    });
    emit(JSON.stringify({ enrolled: true }));
  } else if (verb === "tokens") {
    const { setupTokens } = await admin.call<{ setupTokens: { status: string }[] }>(
      "devices.setupToken.list",
      {},
    );
    emit(JSON.stringify({ tokens: setupTokens.map((t) => t.status) }));
  }
}
lines.on("close", () => void stop());
