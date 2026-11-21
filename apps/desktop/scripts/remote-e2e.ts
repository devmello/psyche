// biome-ignore-all lint/suspicious/noConsole: a manual command-line tool that prints its progress
// biome-ignore-all lint/suspicious/noExplicitAny: replies are printed, not used, so they stay untyped
// Manual end-to-end check of a remote Host from another computer. Not part of any test suite.
// It pairs the way the desktop app does (pinned identity key, pinned LAN certificate), then runs
// threads.list, threads.create and chat.send. Without a model the answer is "No model is configured yet".
//
//   node apps/desktop/scripts/remote-e2e.ts '<psyche-pair:v2:...>' [state-dir]
//   node apps/desktop/scripts/remote-e2e.ts https://<server ip>:7979      # typed address:
//       prints a pairing code; approve it on the server with `psyche pairing approve <code>`
//
// If this computer cannot resolve the server's <hostname>.local name, dial an address instead:
//   E2E_DIAL_HOST=<server ip> node apps/desktop/scripts/remote-e2e.ts '<link>'
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, parsePairingLinkAny } from "../../../packages/protocol/src/index.ts";
import { GatewayConnection } from "../../web/src/client/index.ts";
import {
  loadOrCreateDeviceKey,
  platformFromNode,
  signWithDeviceKey,
} from "../src/lib/device-key.ts";
import { createGatewayVerifier, fingerprintOf } from "../src/lib/gateway-identity.ts";
import { createPinnedFetch, createPinnedWebSocket, PinnedChannel } from "../src/lib/lan-tls.ts";

const link = process.argv[2];
if (!link) throw new Error("usage: remote-e2e.ts <psyche-pair:v2 link> [state-dir]");
const dir = process.argv[3] ?? mkdtempSync(join(tmpdir(), "psyche-e2e-client-"));
// A typed address (https://host:7979) pairs without a link: trust on first use, approved on the Host.
const typed = /^https:/i.test(link);
const parsed = typed ? undefined : parsePairingLinkAny(link);
if (parsed !== undefined && parsed.version !== 2) throw new Error("expected a v2 (LAN) link");
const p = parsed?.payload ?? {
  gatewayUrl: link,
  gatewayKey: undefined,
  certPin: undefined,
  setupToken: undefined,
  hostName: "typed address",
};
const origin = new URL(p.gatewayUrl).origin;
console.log(
  "target",
  origin,
  "host",
  p.hostName,
  p.gatewayKey ? `key ${fingerprintOf(p.gatewayKey)}` : "(no key pinned yet: trust on first use)",
);
// An .orb.local or IP override for a host whose mDNS name the Mac cannot resolve:
const dial = process.env.E2E_DIAL_HOST;
const url = new URL(origin);
const dialHost = dial ?? url.hostname;
const key = loadOrCreateDeviceKey(join(dir, "device-key.json"));
let pinnedKey: string | undefined;
const pinnedCert: string | undefined = p.certPin;
const channel = new PinnedChannel({
  host: dialHost,
  port: Number(url.port || 443),
  pinned: () => pinnedCert,
});
const verifier = createGatewayVerifier({
  dialedOrigin: origin,
  mode: "strict",
  pinnedKey: () => pinnedKey,
  pinnedFingerprint: () => (p.gatewayKey ? fingerprintOf(p.gatewayKey) : undefined),
  lan: { observedSpki: () => channel.observedSpki(), pinnedSpki: () => pinnedCert },
});
const wsUrl = new URL("/ws", origin);
wsUrl.protocol = "wss:";
let resolveStatus: (s: any) => void;
const paired = new Promise<any>((r) => {
  resolveStatus = r;
});
const events: string[] = [];
const conn = new GatewayConnection({
  wsUrl: wsUrl.toString(),
  healthUrl: new URL("/healthz", origin).toString(),
  connectParams: () => ({
    protocolVersion: { min: 1, max: PROTOCOL_VERSION },
    deviceId: key.deviceId,
    publicKey: key.publicKey,
    role: "client",
    platform: platformFromNode(process.platform),
    deviceFamily: "desktop",
    name: `Psyche e2e client (${hostname()})`.slice(0, 64),
  }),
  sign: (payload) => signWithDeviceKey(key, payload),
  verifyGateway: verifier,
  setupToken: () => p.setupToken,
  createWebSocket: (u) => createPinnedWebSocket(channel, u),
  fetch: createPinnedFetch(channel),
  onStatus: (s) => {
    console.log("status:", JSON.stringify(s));
    if (s.phase === "pending")
      console.log("PENDING: code", (s as any).code, "- approve it on the Host");
    if (s.phase === "paired" || s.phase === "error" || s.phase === "denied") resolveStatus(s);
  },
  onEvent: (e) => events.push(e.event),
});
conn.start();
const status = await Promise.race([
  paired,
  new Promise<any>((_, rej) => setTimeout(() => rej(new Error("pairing timed out")), 120000)),
]);
if (status.phase !== "paired") {
  console.log("FAILED to pair:", JSON.stringify(status));
  conn.stop();
  process.exit(1);
}
console.log("PAIRED: identity key and certificate pin held (cert pin", channel.observedSpki(), ")");
const list: any = await conn.call("threads.list", {});
console.log("threads.list ->", list.threads.length, "thread(s)");
const created: any = await conn.call("threads.create", { title: "e2e from the Mac" });
const threadId = created.thread.id;
console.log("threads.create ->", threadId);
const sent: any = await conn.call("chat.send", {
  threadId,
  content: "Hello from the remote client",
});
console.log("chat.send ->", JSON.stringify(sent));
await new Promise((r) => setTimeout(r, 6000));
const hist: any = await conn.call("chat.history", { threadId });
for (const m of hist.messages.slice().reverse())
  console.log(`[${m.role}]`, JSON.stringify(m).slice(0, 400));
console.log("events seen:", [...new Set(events)].join(", "));
conn.stop();
process.exit(0);
