/**
 * First admin without a terminal (packaged first run, approved design): once this window pairs
 * without `operator.admin`, main asks the Gateway for `devices.bootstrapAdmin`. The Gateway grants
 * it only while it has no admin device at all, in one transaction, and audits it; afterwards it
 * answers `conflict` and this does nothing. Main only: the renderer may never call it
 * (`checkCallable`). On success the connection is restarted so its status carries the new scope.
 */
export interface BootstrapAdminDeps {
  packaged: boolean;
  scopes: () => readonly string[] | undefined;
  call: (method: string, params: unknown, options: { idempotencyKey: string }) => Promise<unknown>;
  reconnect: () => void;
  warn: (message: string) => void;
  now?: () => number;
}

export async function bootstrapAdminIfNeeded(deps: BootstrapAdminDeps): Promise<boolean> {
  if (!deps.packaged) return false;
  if (deps.scopes()?.includes("operator.admin")) return false;
  try {
    await deps.call(
      "devices.bootstrapAdmin",
      {},
      { idempotencyKey: `bootstrap-admin:${(deps.now ?? Date.now)()}` },
    );
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // conflict: an admin already exists (the normal case after the first run).
    if (code !== "conflict") deps.warn(`first-admin bootstrap failed (${code ?? "error"})`);
    return false;
  }
  deps.reconnect();
  return true;
}
