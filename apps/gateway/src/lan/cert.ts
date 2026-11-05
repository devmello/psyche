import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { PsycheError, parseIpv6 } from "@psyche/protocol";
import { restrictDirToCurrentUser } from "@psyche/protocol/platform";
import { type DerName, derCertificate } from "./der.ts";

/**
 * The LAN listener's self-signed TLS certificate (remote-gateway design §3.1, "LAN"). There is
 * no public CA for `<host>.local`, so clients do not trust it through the system: they pin the
 * SHA-256 of its SPKI (and the Gateway's identity key signs that hash into every LAN challenge).
 * The pin is of the KEY, so the certificate can be reissued for a changed address without
 * breaking a pin; only `rotateLanCert` (a new key) makes clients pair again.
 *
 * ECDSA P-256, valid 825 days, reissued (same key) 30 days before it expires or when its names
 * change. Files: `$PSYCHE_HOME/identity/lan-tls/{key.pem,cert.pem}`, directory 0700, files 0600.
 */

const VALID_DAYS = 825;
const RENEW_BEFORE_MS = 30 * 86_400_000;

export interface LanCert {
  keyPem: string;
  certPem: string;
  /** SHA-256 of the SubjectPublicKeyInfo, base64url: the cert pin. */
  spki: string;
  /** The DNS names and addresses the certificate is valid for, lower case. */
  names: string[];
}

export function lanTlsDir(home: string): string {
  return join(home, "identity", "lan-tls");
}

/** SHA-256 (base64url) of a certificate's SPKI, from PEM or DER. */
export function spkiPin(cert: string | Buffer): string {
  const spki = new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" });
  return createHash("sha256").update(spki).digest("base64url");
}

function certNames(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? "")
    .split(",")
    .map((part) => /^\s*(?:DNS|IP Address):(.+?)\s*$/.exec(part)?.[1] ?? "")
    .filter((name) => name !== "")
    .map((name) => name.toLowerCase());
}

function writePrivate(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function newKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function issue(privateKey: KeyObject, names: readonly string[], now: Date): string {
  const publicKey = createPublicKey(privateKey);
  const commonName = names.find((n) => isIP(n) === 0) ?? "psyche-gateway";
  const subject: DerName = [
    ["2.5.4.3", commonName],
    ["2.5.4.10", "Psyche Gateway"],
  ];
  const der = derCertificate({
    // 127 bits at most: a positive INTEGER with the high bit clear.
    serial: Buffer.concat([Buffer.from([0x01]), randomBytes(15)]),
    subject,
    notBefore: new Date(now.getTime() - 5 * 60_000),
    notAfter: new Date(now.getTime() + VALID_DAYS * 86_400_000),
    spki: publicKey.export({ type: "spki", format: "der" }),
    dnsNames: names.filter((n) => isIP(n) === 0),
    ipv4: names.filter((n) => isIP(n) === 4),
    ipv6: names
      .filter((n) => isIP(n) === 6)
      .flatMap((n) => {
        const groups = parseIpv6(n);
        return groups === null ? [] : [groups];
      }),
    signTbs: (tbs) => sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" }),
  });
  const b64 = der.toString("base64");
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * One spelling per name: Node prints an IPv6 SAN uncompressed (`FD12:0:0:0:0:0:0:1`) while the
 * interface list gives `fd12::1`; without this the certificate would look changed on every start.
 */
function canonicalName(name: string): string {
  const groups = isIP(name) === 6 ? parseIpv6(name) : null;
  return groups === null ? name.toLowerCase() : groups.map((g) => g.toString(16)).join(":");
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a.map(canonicalName))].sort();
  const y = [...new Set(b.map(canonicalName))].sort();
  return x.length === y.length && x.every((n, i) => n === y[i]);
}

function describe(keyPem: string, certPem: string): LanCert {
  return {
    keyPem,
    certPem,
    spki: spkiPin(certPem),
    names: certNames(new X509Certificate(certPem)),
  };
}

/**
 * Loads the certificate, generating the key on first use and reissuing the certificate (same
 * key) when `names` changed or it expires within 30 days. A key file that exists but cannot be
 * read is an error, never a fresh key: replacing it makes every client pair again, so that only
 * happens through `rotateLanCert`.
 */
export async function ensureLanCert(
  home: string,
  names: readonly string[],
  now: Date = new Date(),
): Promise<LanCert> {
  const dir = lanTlsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(join(home, "identity"), 0o700);
  // 0700 on POSIX; on Windows (no modes) the folder's DACL: this user and SYSTEM only.
  restrictDirToCurrentUser(dir);
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  let keyPem: string | undefined;
  try {
    keyPem = readFileSync(keyPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (keyPem !== undefined) {
    let key: KeyObject;
    try {
      key = createPrivateKey(keyPem);
    } catch {
      throw new PsycheError(
        "internal",
        `${keyPath} is not a valid key; refusing to replace the LAN certificate`,
      );
    }
    chmodSync(keyPath, 0o600);
    try {
      const certPem = readFileSync(certPath, "utf8");
      const current = new X509Certificate(certPem);
      const fresh = new Date(current.validTo).getTime() - now.getTime() > RENEW_BEFORE_MS;
      if (fresh && current.checkPrivateKey(key) && sameNames(certNames(current), names)) {
        chmodSync(certPath, 0o600);
        return describe(keyPem, certPem);
      }
    } catch {
      // Missing or unreadable certificate: reissue for the same key below.
    }
    const certPem = issue(key, names, now);
    writePrivate(certPath, certPem);
    return describe(keyPem, certPem);
  }
  keyPem = newKeyPem();
  writePrivate(keyPath, keyPem);
  const certPem = issue(createPrivateKey(keyPem), names, now);
  writePrivate(certPath, certPem);
  return describe(keyPem, certPem);
}

/** A new key and certificate. Every client that pinned the old one must pair again. */
export async function rotateLanCert(
  home: string,
  names: readonly string[],
  now: Date = new Date(),
): Promise<LanCert> {
  const dir = lanTlsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictDirToCurrentUser(dir);
  const keyPem = newKeyPem();
  const certPem = issue(createPrivateKey(keyPem), names, now);
  writePrivate(join(dir, "key.pem"), keyPem);
  writePrivate(join(dir, "cert.pem"), certPem);
  return describe(keyPem, certPem);
}
