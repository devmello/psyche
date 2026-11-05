/**
 * Drives the real system-bus client of password presence for tests/linux/polkit_dbusmock_test.py:
 * `preflight`, `prompt` (preflight, then the interactive check) or `cancel` (the interactive
 * check, cancelled after a moment). Prints one JSON line. The bus is whatever
 * DBUS_SYSTEM_BUS_ADDRESS names, which the client honors only with PSYCHE_TEST_SYSTEM_BUS=1.
 */
import {
  PRESENCE_ACTION_ID,
  preflight,
  systemPresenceBus,
} from "../../src/compose/password-presence.ts";

const command = process.argv[2] ?? "prompt";
const bus = await systemPresenceBus();
const out: Record<string, unknown> = {};
try {
  const pre = await preflight(bus, process.getuid?.() ?? -1);
  out.pre = pre;
  if (command !== "preflight" && pre.state === "ready" && pre.sessionId !== undefined) {
    const started = Date.now();
    const pending = bus.checkAuthorization(pre.sessionId, PRESENCE_ACTION_ID, 1, "psyche-test");
    if (command === "cancel") {
      setTimeout(() => void bus.cancelCheckAuthorization("psyche-test"), 400);
    }
    try {
      out.result = await pending;
    } catch (err) {
      out.error = (err as { dbusName?: string }).dbusName ?? String(err);
    }
    out.elapsedMs = Date.now() - started;
  }
} finally {
  bus.close();
}
console.log(JSON.stringify(out));
