import { type MethodParams, PsycheError } from "@psyche/protocol";
import type { Call, HandlerDef } from "../context.ts";

/**
 * `browser.cookieImport.record` (docs/design/cookie-import-2026.md): the desktop app writes an
 * audit entry after the owner imported sign-ins from another browser, or removed them. The
 * import itself runs in the desktop's main process; there is no Gateway method or tool that
 * imports, so the agent, MCP servers, widgets, channels and paired devices can't start one.
 * This method records only domains and counts, and only the desktop shell's own connection may
 * call it.
 */

export interface CookieImportAudit {
  append(entry: {
    kind: string;
    actor: { type: "device"; deviceId: string };
    data: Record<string, unknown>;
  }): unknown;
}

export function cookieImportHandlers(audit: CookieImportAudit): Record<string, HandlerDef> {
  return {
    "browser.cookieImport.record": {
      async run(call: Call, params: MethodParams<"browser.cookieImport.record">) {
        if (call.identity.desktopShell !== true) {
          throw new PsycheError(
            "forbidden",
            "only the Psyche desktop app on this computer records a cookie import",
          );
        }
        const sites = params.sites.map((s) => ({ domain: s.domain, cookies: s.cookies }));
        await audit.append({
          kind: `browser.cookies.${params.action}`,
          actor: { type: "device", deviceId: call.identity.deviceId },
          data: {
            browser: params.browser,
            sites,
            total: sites.reduce((n, s) => n + s.cookies, 0),
          },
        });
        return { ok: true as const };
      },
    },
  };
}
