#!/bin/bash
# Creates Psyche's self-signed release code-signing certificate (docs/design/updates-and-install-2026.md §2.3).
# Run it ONCE, on the owner's Mac, and keep the .p12 safe: the certificate is the app's identity.
# Losing it, or replacing it, breaks auto-update and resets every macOS privacy grant for everyone.
#
#   deploy/macos/make-signing-cert.sh --out <dir> [--algo rsa|ec] [--days 7305]
#                                     [--import-to <keychain>] [--password-file <file>]
#
#   --out <dir>          where psyche-release.p12 is written (created 0700). Refuses to overwrite one.
#   --algo rsa|ec        rsa = RSA 3072 (default; works everywhere), ec = EC P-256.
#   --days N             validity in days (default 7305, about 20 years).
#   --import-to <kc>     ALSO import the identity into this named keychain (a path or a name such as
#                        "psyche-signing.keychain-db"). Default: import nothing. The login keychain is
#                        refused. Nothing is ever added to the search list or marked trusted.
#                        If PSYCHE_KEYCHAIN_PASSWORD is set it is used to let codesign use the key
#                        without a prompt (set-key-partition-list); otherwise macOS asks on first use.
#   --password-file <f>  read the .p12 password from the first line of this file instead of asking
#                        (for scripted use; the file should be 0600). Default: asks twice on the
#                        terminal, with no echo.
#
# What it makes: CN "Psyche Release", basicConstraints CA:false, keyUsage digitalSignature, Extended
# Key Usage codeSigning (critical). The private key exists only in a 0700 temp dir that is removed on
# exit, and inside the .p12. The password is never echoed, logged or put on a command line.
#
# It prints the SHA-1 and SHA-256 of the certificate and the designated requirement it implies. Put the
# SHA-1 in deploy/macos/designated-requirements.txt (see deploy/macos/check-designated-requirements.sh).
set -euo pipefail

OUT=""
ALGO="rsa"
DAYS=7305
IMPORT_TO=""
PW_FILE=""
usage() { sed -n '2,23p' "$0"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a directory}"; shift 2 ;;
    --algo) ALGO="${2:?--algo needs rsa or ec}"; shift 2 ;;
    --days) DAYS="${2:?--days needs a number}"; shift 2 ;;
    --import-to) IMPORT_TO="${2:?--import-to needs a keychain}"; shift 2 ;;
    --password-file) PW_FILE="${2:?--password-file needs a file}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done
[ -n "$OUT" ] || { echo "--out <dir> is required" >&2; usage >&2; exit 64; }
case "$ALGO" in rsa|ec) ;; *) echo "--algo must be rsa or ec" >&2; exit 64 ;; esac
case "$DAYS" in ""|*[!0-9]*) echo "--days must be a number" >&2; exit 64 ;; esac
[ "$DAYS" -ge 365 ] || { echo "--days must be at least 365" >&2; exit 64; }
OPENSSL="${OPENSSL:-openssl}"
command -v "$OPENSSL" >/dev/null || { echo "openssl not found" >&2; exit 2; }

P12="$OUT/psyche-release.p12"
[ ! -e "$P12" ] || { echo "refusing to overwrite $P12 (move it away first; the old one is the app's identity)" >&2; exit 1; }

if [ -n "$IMPORT_TO" ]; then
  [ "$(uname -s)" = Darwin ] || { echo "--import-to needs macOS (security)" >&2; exit 2; }
  case "$IMPORT_TO" in
    *login.keychain*|"$HOME/Library/Keychains/login"*) echo "refusing to import into the login keychain; name another keychain" >&2; exit 1 ;;
  esac
fi

# The password: from the terminal without echo, or from a file. Kept only in this shell's variable
# and handed to openssl and security through the environment, never as an argument.
if [ -n "$PW_FILE" ]; then
  [ -r "$PW_FILE" ] || { echo "cannot read $PW_FILE" >&2; exit 1; }
  IFS= read -r PSYCHE_P12_PASSWORD < "$PW_FILE" || true
else
  [ -r /dev/tty ] || { echo "no terminal to ask for the password on; use --password-file" >&2; exit 1; }
  printf 'Password for the .p12 (not shown): ' > /dev/tty
  IFS= read -rs PSYCHE_P12_PASSWORD < /dev/tty; printf '\n' > /dev/tty
  printf 'Again: ' > /dev/tty
  IFS= read -rs again < /dev/tty; printf '\n' > /dev/tty
  [ "$PSYCHE_P12_PASSWORD" = "$again" ] || { echo "the passwords differ" >&2; exit 1; }
  again=""
fi
[ "${#PSYCHE_P12_PASSWORD}" -ge 12 ] || { echo "use a password of at least 12 characters" >&2; exit 1; }
export PSYCHE_P12_PASSWORD

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/psyche-cert.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT"
chmod 700 "$OUT"

cat > "$WORK/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Psyche Release
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

if [ "$ALGO" = ec ]; then
  KEYOPT=(-newkey ec -pkeyopt ec_paramgen_curve:prime256v1)
else
  KEYOPT=(-newkey rsa:3072)
fi
"$OPENSSL" req -x509 -nodes "${KEYOPT[@]}" -sha256 -days "$DAYS" -config "$WORK/openssl.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null

# Legacy PBE and a SHA-1 MAC: the only .p12 flavour macOS `security import` reads, from LibreSSL
# and OpenSSL 3+ alike. (The .p12 is protected by the password and file mode 0600.)
"$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "Psyche Release" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout env:PSYCHE_P12_PASSWORD -out "$P12"
chmod 600 "$P12"

hash_of() { "$OPENSSL" x509 -in "$WORK/cert.pem" -noout -fingerprint "-$1" | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'; }
SHA1="$(hash_of sha1)"
SHA256="$(hash_of sha256)"
NOT_AFTER="$("$OPENSSL" x509 -in "$WORK/cert.pem" -noout -enddate | sed 's/notAfter=//')"

if [ -n "$IMPORT_TO" ]; then
  security import "$P12" -k "$IMPORT_TO" -P "$PSYCHE_P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  if [ -n "${PSYCHE_KEYCHAIN_PASSWORD:-}" ]; then
    security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PSYCHE_KEYCHAIN_PASSWORD" "$IMPORT_TO" >/dev/null
  fi
  echo "imported into $IMPORT_TO (not trusted, not added to the search list)"
fi

cat <<EOF

Wrote $P12   (mode 0600)

  Common name      Psyche Release
  Algorithm        $([ "$ALGO" = ec ] && echo "EC P-256" || echo "RSA 3072")
  Expires          $NOT_AFTER
  SHA-1            $SHA1
  SHA-256          $SHA256

Designated requirement this certificate gives the app and the helper:

  identifier "com.psyche.desktop" and certificate leaf = H"$SHA1"
  identifier "com.psyche.helper" and certificate leaf = H"$SHA1"

Next:
  1. Back up $P12 and its password in your password manager. If either is lost, every user must
     reinstall by hand and re-grant every macOS permission.
  2. Put the SHA-1 above in deploy/macos/designated-requirements.txt and commit that file.
  3. GitHub secrets: MACOS_CERTIFICATE_P12_BASE64 (base64 -i $P12 | pbcopy), MACOS_CERTIFICATE_PASSWORD,
     MACOS_SIGNING_IDENTITY = $SHA1  (the hash, so the name can never match another certificate).
  4. Delete the .p12 from this folder once it is backed up; this script never imports it anywhere
     unless you passed --import-to.
EOF
