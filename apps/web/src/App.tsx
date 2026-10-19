import { PsycheMark, StatusPill, type StatusTone } from "@psyche/ui";
import { type ReactElement, useEffect, useState } from "react";
import { WebGatewayClient } from "./gateway.ts";
import { type GatewayStatus, INITIAL_STATUS, type PairingPhase } from "./lib/status.ts";

const PHASE_LABEL: Record<PairingPhase, { label: string; tone: StatusTone }> = {
  idle: { label: "idle", tone: "neutral" },
  connecting: { label: "connecting", tone: "neutral" },
  challenge: { label: "challenge received", tone: "neutral" },
  verifying: { label: "verifying", tone: "neutral" },
  paired: { label: "paired", tone: "ok" },
  pending: { label: "pending pairing", tone: "warn" },
  denied: { label: "denied", tone: "error" },
  disconnected: { label: "disconnected", tone: "warn" },
  error: { label: "error", tone: "error" },
};

export function App(): ReactElement {
  const [status, setStatus] = useState<GatewayStatus>(INITIAL_STATUS);

  useEffect(() => {
    const client = new WebGatewayClient(setStatus);
    client.start();
    return () => client.stop();
  }, []);

  const phase = PHASE_LABEL[status.phase];
  return (
    <main
      style={{ fontFamily: "system-ui, sans-serif", padding: 16, lineHeight: 1.5, maxWidth: 640 }}
    >
      <h1 style={{ margin: "0 0 24px" }}>
        <PsycheMark size={32} />
      </h1>
      <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "8px 16px" }}>
        <dt>Gateway health</dt>
        <dd style={{ margin: 0 }}>
          <StatusPill
            title="GET /healthz"
            tone={
              status.health === "ok" ? "ok" : status.health === "unreachable" ? "error" : "neutral"
            }
            label={status.health === "unknown" ? "checking" : status.health}
          />
        </dd>
        <dt>Pairing</dt>
        <dd style={{ margin: 0 }}>
          <StatusPill title="Device pairing phase" tone={phase.tone} label={phase.label} />
        </dd>
        {status.pairingCode ? (
          <>
            <dt>Pairing code</dt>
            <dd style={{ margin: 0, fontFamily: "ui-monospace, monospace" }}>
              {status.pairingCode}
            </dd>
          </>
        ) : null}
        {status.lastError ? (
          <>
            <dt>Last error</dt>
            <dd style={{ margin: 0 }}>{status.lastError}</dd>
          </>
        ) : null}
      </dl>
      {status.phase === "pending" ? (
        <p>Approve this browser from a paired device (desktop or CLI) to continue.</p>
      ) : null}
    </main>
  );
}
