import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { renderHtml } from "./html.ts";
import {
  FIXTURE_SITE,
  FX_HOSTS,
  type FxHost,
  type FxSite,
  loginUser,
  NOT_FOUND_PAGE,
  resolveHref,
  SESSION_COOKIE,
  submissionPage,
} from "./site.ts";

/** `Cookie: a=1; b=2` → map. */
function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out.set(part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim()));
  }
  return out;
}

/**
 * Serves the fixture site on 127.0.0.1 for real browsers. Hosts are `site-a.localhost`,
 * `site-b.localhost` and `evil.localhost` on one port; Chromium resolves `*.localhost` to
 * loopback itself, so no DNS or /etc/hosts changes are needed and nothing leaves the machine.
 */
export class FixtureServer {
  readonly site: FxSite;
  readonly submissions: { path: string; fields: [string, string][] }[] = [];
  #server: Server | undefined;
  #port = 0;

  constructor(site: FxSite = FIXTURE_SITE) {
    this.site = site;
  }

  get port(): number {
    return this.#port;
  }

  origin = (h: FxHost): string => `http://${FX_HOSTS[h]}.localhost:${this.#port}`;

  url(key: string): string {
    const i = key.indexOf("/");
    return resolveHref(key.slice(i), key.slice(0, i) as FxHost, this.origin);
  }

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      void this.#handle(req).then(({ status, headers, body }) => {
        res.writeHead(status, headers);
        res.end(body);
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.#server === undefined) resolve();
      else {
        this.#server.closeAllConnections();
        this.#server.close(() => resolve());
      }
    });
  }

  async #handle(
    req: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const hostHeader = (req.headers.host ?? "").split(":")[0] ?? "";
    const host = (Object.keys(FX_HOSTS) as FxHost[]).find(
      (h) => `${FX_HOSTS[h]}.localhost` === hostHeader,
    );
    if (host === undefined) return { status: 421, headers: {}, body: "unknown host" };
    const url = new URL(req.url ?? "/", this.origin(host));
    const key = `${host}${url.pathname}`;
    const html: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
    const cookies = parseCookies(req.headers.cookie);
    const redirect = this.site.redirects[key];
    if (redirect !== undefined) {
      return {
        status: 302,
        headers: { location: resolveHref(redirect, host, this.origin) },
        body: "",
      };
    }
    const dl = this.site.downloads[key];
    if (dl !== undefined) {
      return {
        status: 200,
        headers: {
          "content-type": dl.mime,
          "content-disposition": `attachment; filename="${dl.filename}"`,
        },
        body: dl.body,
      };
    }
    if (url.pathname.startsWith("/submit/")) {
      const fields: [string, string][] = [...url.searchParams.entries()];
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = Buffer.concat(chunks).toString("utf8");
        const type = req.headers["content-type"] ?? "";
        if (type.startsWith("application/x-www-form-urlencoded")) {
          fields.push(...new URLSearchParams(body).entries());
        } else if (type.startsWith("multipart/form-data")) {
          for (const m of body.matchAll(/name="([^"]+)"(?:; filename="([^"]*)")?/g)) {
            fields.push([m[1] ?? "", m[2] ?? "(field)"]);
          }
        }
      }
      this.submissions.push({ path: url.pathname, fields });
      // A login sets the session cookie the `a/account` page reads (I15 isolation proof).
      const user = loginUser(url.pathname, fields);
      const headers = { ...html };
      if (user !== undefined) {
        cookies.set(SESSION_COOKIE, user);
        // Persistent (Max-Age), so the profile keeps it across a context relaunch.
        headers["set-cookie"] =
          `${SESSION_COOKIE}=${encodeURIComponent(user)}; Path=/; Max-Age=3600`;
      }
      return {
        status: 200,
        headers,
        body: renderHtml(submissionPage(url.pathname, fields), host, this.origin, cookies),
      };
    }
    // `/spa/two` and friends render the SPA shell, as a history-API app would.
    const page =
      this.site.pages[key] ??
      (url.pathname.startsWith("/spa/") ? this.site.pages[`${host}/spa`] : undefined);
    if (page === undefined) {
      return { status: 404, headers: html, body: renderHtml(NOT_FOUND_PAGE, host, this.origin) };
    }
    return {
      status: page.status ?? 200,
      headers: html,
      body: renderHtml(page, host, this.origin, cookies),
    };
  }
}
