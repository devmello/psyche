/**
 * The few bytes of DER a self-signed server certificate needs (RFC 5280), written out so the
 * Gateway does not pull in an ASN.1 library for one certificate. Node parses and checks what this
 * makes (`X509Certificate`, and a real TLS handshake in the tests).
 */

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}

const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const [a = 0, b = 0, ...rest] = parts;
  const out: number[] = [a * 40 + b];
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function integer(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && ((b[1] ?? 0) & 0x80) === 0) b = b.subarray(1);
  if (((b[0] ?? 0) & 0x80) !== 0) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function time(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  // RFC 5280: UTCTime up to 2049, GeneralizedTime from 2050.
  return y >= 2050
    ? tlv(0x18, Buffer.from(`${String(y).padStart(4, "0")}${rest}`, "ascii"))
    : tlv(0x17, Buffer.from(`${p(y % 100)}${rest}`, "ascii"));
}

/** Attribute type OID and value pairs, in order (`["2.5.4.3", "host"]` is the common name). */
export type DerName = [oid: string, value: string][];

function name(n: DerName): Buffer {
  return seq(...n.map(([o, v]) => set(seq(oid(o), tlv(0x0c, Buffer.from(v, "utf8"))))));
}

function extension(o: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(o), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}

export interface DerCertificateInput {
  serial: Buffer;
  subject: DerName;
  notBefore: Date;
  notAfter: Date;
  /** DER SubjectPublicKeyInfo of the key being certified. */
  spki: Buffer;
  dnsNames: string[];
  ipv4: string[];
  /** IPv6 addresses as eight 16-bit groups each (`parseIpv6`). */
  ipv6: (readonly number[])[];
  /** Signs the TBSCertificate with ecdsa-with-SHA256 and returns a DER ECDSA-Sig-Value. */
  signTbs(tbs: Buffer): Buffer;
}

/** A self-signed v3 end-entity certificate: not a CA, digitalSignature, serverAuth, SAN. */
export function derCertificate(input: DerCertificateInput): Buffer {
  const sigAlg = seq(oid("1.2.840.10045.4.3.2"));
  const subject = name(input.subject);
  const san = seq(
    ...input.dnsNames.map((d) => tlv(0x82, Buffer.from(d, "ascii"))),
    ...input.ipv4.map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
    ...input.ipv6.map((g) =>
      tlv(0x87, Buffer.concat(g.map((x) => Buffer.from([(x >> 8) & 0xff, x & 0xff])))),
    ),
  );
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(input.serial),
    sigAlg,
    subject,
    seq(time(input.notBefore), time(input.notAfter)),
    subject,
    input.spki,
    tlv(
      0xa3,
      seq(
        extension("2.5.29.19", true, seq()),
        extension("2.5.29.15", true, tlv(0x03, Buffer.from([0x07, 0x80]))),
        extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
        extension("2.5.29.17", false, san),
      ),
    ),
  );
  return seq(tbs, sigAlg, tlv(0x03, Buffer.from([0x00]), input.signTbs(tbs)));
}
