import {
  nodeTransport,
  type PinnedRequest,
  type SafeFetchOptions,
  type Transport,
  vetUrl,
} from "@psyche/connectors";
import { PsycheError } from "@psyche/protocol";

/**
 * The Gateway image proxy for widgets (generative-ui-2026 §7.2, D3). A widget's remote image is
 * fetched here, never by the page: no cookies, no referrer, https only, every hop and every
 * resolved address vetted against private ranges, image types only (SVG is refused: it can carry
 * script), and a hard size and time cap. So an injected spec cannot use it as a tracking beacon
 * against the owner's address or as a way into the LAN.
 */

export const WIDGET_IMAGE_MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_HOPS = 3;
const MAX_INFLIGHT = 4;
const ALLOWED = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type WidgetImageMime = (typeof ALLOWED)[number];

let inflight = 0;

export interface FetchedImage {
  mime: WidgetImageMime;
  bytes: Uint8Array;
}

/** Magic numbers: the declared type must match the bytes, so a mislabelled body is not passed on. */
function sniff(b: Uint8Array): WidgetImageMime | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return "image/gif";
  if (
    b.length > 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return null;
}

const header = (v: string | string[] | undefined): string =>
  Array.isArray(v) ? (v[0] ?? "") : (v ?? "");

export async function fetchWidgetImage(
  input: string,
  options: Pick<SafeFetchOptions, "lookup"> & { transport?: Transport } = {},
): Promise<FetchedImage> {
  if (inflight >= MAX_INFLIGHT)
    throw new PsycheError("unavailable", "too many image fetches; try again", { retryable: true });
  inflight++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const transport = options.transport ?? nodeTransport;
  try {
    let url = new URL(input);
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (url.protocol !== "https:") {
        throw new PsycheError("policy_denied", "widget images load over https only");
      }
      const target = await vetUrl(url, {
        signal: ctl.signal,
        ...(options.lookup ? { lookup: options.lookup } : {}),
      });
      const req: PinnedRequest = {
        url: target.url,
        address: target.address,
        family: target.family,
        headers: {
          accept: "image/png,image/jpeg,image/gif,image/webp",
          "user-agent": "psyche-gateway",
        },
        signal: ctl.signal,
      };
      const res = await transport(req);
      if (res.status >= 300 && res.status < 400) {
        res.close();
        const next = header(res.headers.location);
        if (next === "") throw new PsycheError("unavailable", "the image host redirected nowhere");
        url = new URL(next, url);
        continue;
      }
      if (res.status !== 200) {
        res.close();
        throw new PsycheError("unavailable", `the image host answered ${res.status}`);
      }
      const declared =
        header(res.headers["content-type"]).split(";")[0]?.trim().toLowerCase() ?? "";
      if (!(ALLOWED as readonly string[]).includes(declared)) {
        res.close();
        throw new PsycheError("policy_denied", "only PNG, JPEG, GIF and WebP images are shown");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > WIDGET_IMAGE_MAX_BYTES) {
          res.close();
          throw new PsycheError("policy_denied", "the image is larger than 512 KiB");
        }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const real = sniff(bytes);
      if (real === null || real !== declared) {
        throw new PsycheError("policy_denied", "the image content does not match its type");
      }
      return { mime: real, bytes };
    }
    throw new PsycheError("unavailable", "too many redirects");
  } catch (e) {
    if (e instanceof PsycheError) throw e;
    throw new PsycheError("unavailable", "the image could not be fetched", { retryable: true });
  } finally {
    clearTimeout(timer);
    inflight--;
  }
}
