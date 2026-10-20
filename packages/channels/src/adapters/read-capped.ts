import { PsycheError } from "@psyche/protocol";

/** Reads a response body up to `max` bytes; larger bodies fail without being buffered. */
export async function readCapped(
  res: Response,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const tooLarge = () =>
    new PsycheError("invalid_params", "attachment too large", { details: { max } });
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (res.body === null) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw tooLarge();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted === true) {
        throw new PsycheError("cancelled", "attachment download aborted");
      }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw tooLarge();
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    if (err instanceof PsycheError) throw err;
    throw new PsycheError("unavailable", "attachment download failed", { retryable: true });
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
