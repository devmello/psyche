#!/bin/bash
# Creates Psyche's self-signed release code-signing certificate (docs/design/updates-and-install-2026.md §2.3).
# Run it ONCE, on the owner's Mac, and keep the .p12 safe: the certificate is the app's identity.
# Losing it, or replacing it, breaks auto-update and resets every macOS privacy grant for everyone.
#
#   deploy/macos/make-signing-cert.sh --out <dir> [--algo rsa|ec] [--days 7305]
#                                     [--import-to <keychain>] [--password-file <file>]
#
#   --out <dir>          where psyche-release.p12 is written. Created 0700. An existing directory must
#                        be yours and 0700. Refused: a path inside a git work tree (a .p12 must never
#                        be committed) and an existing .p12 (it never overwrites one).
#   --algo rsa|ec        rsa = RSA 3072 (default; works everywhere), ec = EC P-256.
#   --days N             validity in days (default 7305, about 20 years).
#   --import-to <kc>     ALSO import the identity into this named keychain (a path or a name such as
#                        "psyche-signing.keychain-db"). Default: import nothing. The login keychain
#                        (login, login.keychain, login.keychain-db, with or without a path) is refused. Only
#                        /usr/bin/codesign is allowed to use the key. Nothing is added to the search
#                        list or marked trusted, and the keychain is locked again afterwards. Then run
#                        the `security set-key-partition-list` line it prints (it asks for the keychain
#                        password itself; this script never takes it).
#   --password-file <f>  read the .p12 password from the first line of this file instead of asking
#                        (for scripted use; the file should be 0600). Default: asks twice on the
#                        terminal, with no echo.
#
# The password: 16 characters at least; use 20 or more, random: `openssl rand -base64 24`, kept in your
# password manager. It protects the .p12 and the temporary private key. This script never puts it on a
# command line, in its output or in a log, and never echoes it.
#
# What it makes: CN "Psyche Release", basicConstraints CA:false, keyUsage digitalSignature, Extended
# Key Usage codeSigning (critical). While it runs, the private key lives in a 0700 temp dir that is
# removed on exit, encrypted with your password. The finished key exists in the .p12.
# With --import-to there is one more, short-lived file in that temp dir: a copy of the .p12 protected
# by a RANDOM ONE-OFF password (not yours), because `security import` can only take a password as a
# command-line argument and rejects an empty one. That one-off password is visible to `ps` for the
# seconds the import takes, and guards nothing but that temp file, which is deleted right after.
#
# It prints the SHA-1 and SHA-256 of the certificate and the designated requirement it implies. Put the
# SHA-1 in deploy/macos/designated-requirements.txt (see deploy/macos/check-designated-requirements.sh).
set -euo pipefail

OUT=""
ALGO="rsa"
DAYS=7305
IMPORT_TO=""
PW_FILE=""
usage() { sed -n '2,38p' "$0"; }
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

# --- where the .p12 goes -------------------------------------------------------------------------
# The nearest directory that exists, to ask git and the filesystem about.
probe="$OUT"
while [ ! -e "$probe" ]; do probe="$(dirname "$probe")"; done
[ -d "$probe" ] || { echo "$probe is not a directory" >&2; exit 1; }
probe_real="$(cd "$probe" && pwd -P)"
if git -C "$probe_real" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "refusing: $OUT is inside a git work tree ($(git -C "$probe_real" rev-parse --show-toplevel)); keep the .p12 outside any repository" >&2
  exit 1
fi
if [ -e "$OUT" ]; then
  [ -d "$OUT" ] || { echo "$OUT exists and is not a directory" >&2; exit 1; }
  owner="$(ls -ldn "$OUT" | awk '{print $3}')"
  [ "$owner" = "$(id -u)" ] || { echo "refusing: $OUT is not owned by you" >&2; exit 1; }
  mode="$(ls -ld "$OUT" | cut -c1-10)"
  [ "$mode" = "drwx------" ] || { echo "refusing: $OUT must be mode 0700 (chmod 700 it first), it is $mode" >&2; exit 1; }
fi
P12="$OUT/psyche-release.p12"
[ ! -e "$P12" ] || { echo "refusing to overwrite $P12 (move it away first; the old one is the app's identity)" >&2; exit 1; }

if [ -n "$IMPORT_TO" ]; then
  [ "$(uname -s)" = Darwin ] || { echo "--import-to needs macOS (security)" >&2; exit 2; }
  kc_base="$(basename "$IMPORT_TO")"
  case "$kc_base" in
    login|login.keychain|login.keychain-db) echo "refusing to import into the login keychain; name another keychain" >&2; exit 1 ;;
  esac
  case "$IMPORT_TO" in
    "$HOME"/Library/Keychains/login*|/Library/Keychains/*|/System/Library/Keychains/*) echo "refusing to import into a system or login keychain; name your own keychain" >&2; exit 1 ;;
  esac
fi

# --- the password --------------------------------------------------------------------------------
# From the terminal without echo, or from a file. Kept only in this shell's variable and handed to
# openssl through the environment, never as an argument.
if [ -n "$PW_FILE" ]; then
  [ -r "$PW_FILE" ] || { echo "cannot read $PW_FILE" >&2; exit 1; }
  IFS= read -r PSYCHE_P12_PASSWORD < "$PW_FILE" || true
else
  [ -r /dev/tty ] || { echo "no terminal to ask for the password on; use --password-file" >&2; exit 1; }
  printf 'Password for the .p12 (20+ random characters, not shown): ' > /dev/tty
  IFS= read -rs PSYCHE_P12_PASSWORD < /dev/tty; printf '\n' > /dev/tty
  printf 'Again: ' > /dev/tty
  IFS= read -rs again < /dev/tty; printf '\n' > /dev/tty
  [ "$PSYCHE_P12_PASSWORD" = "$again" ] || { echo "the passwords differ" >&2; exit 1; }
  again=""
fi
[ "${#PSYCHE_P12_PASSWORD}" -ge 16 ] || { echo "use a password of at least 16 characters (20+ is better): openssl rand -base64 24" >&2; exit 1; }
export PSYCHE_P12_PASSWORD
# OpenSSL 4 fails to read an encrypted key with `-passin env:` when stdin is an open pipe; the
# password was read above, so nothing needs stdin from here on.
exec < /dev/null

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
# No -nodes: the temporary private key is written encrypted with the password.
"$OPENSSL" req -x509 "${KEYOPT[@]}" -sha256 -days "$DAYS" -config "$WORK/openssl.cnf" \
  -passout env:PSYCHE_P12_PASSWORD -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null

# Legacy PBE and a SHA-1 MAC: the only .p12 flavour macOS `security import` reads, from LibreSSL
# and OpenSSL 3+ alike. (The .p12 is protected by the password and file mode 0600.)
"$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -passin env:PSYCHE_P12_PASSWORD -in "$WORK/cert.pem" \
  -name "Psyche Release" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
  -passout env:PSYCHE_P12_PASSWORD -out "$P12"
chmod 600 "$P12"

hash_of() { "$OPENSSL" x509 -in "$WORK/cert.pem" -noout -fingerprint "-$1" | sed 's/.*=//; s/://g' | tr 'A-F' 'a-f'; }
SHA1="$(hash_of sha1)"
SHA256="$(hash_of sha256)"
NOT_AFTER="$("$OPENSSL" x509 -in "$WORK/cert.pem" -noout -enddate | sed 's/notAfter=//')"

if [ -n "$IMPORT_TO" ]; then
  # `security import` takes a .p12 password only as `-P <password>` on its command line, where `ps`
  # would show it (and it rejects an empty one). So import a throwaway copy protected by a random
  # one-off password that guards nothing but a file in this 0700 temp dir for a few seconds. The real
  # password stays off every command line.
  PSYCHE_IMPORT_PW="$("$OPENSSL" rand -hex 24)"
  export PSYCHE_IMPORT_PW
  "$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -passin env:PSYCHE_P12_PASSWORD -in "$WORK/cert.pem" \
    -name "Psyche Release" -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -passout env:PSYCHE_IMPORT_PW -out "$WORK/import.p12"
  security import "$WORK/import.p12" -k "$IMPORT_TO" -P "$PSYCHE_IMPORT_PW" -T /usr/bin/codesign >/dev/null
  rm -f "$WORK/import.p12"
  security lock-keychain "$IMPORT_TO" >/dev/null 2>&1 || true
  echo "imported into $IMPORT_TO (only /usr/bin/codesign may use the key; not trusted, not added to the search list; keychain locked)"
  echo "to let codesign use it without a prompt, run (it asks for the keychain password):"
  echo "  security set-key-partition-list -S apple-tool:,apple:,codesign: -s \"$IMPORT_TO\""
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
     reinstall by hand and re-grant every macOS permission. If the file or password leaks, see
     "Certificate loss, rotation or leak" in docs/design/updates-and-install-2026.md: there is no
     revocation.
  2. Put the SHA-1 above in deploy/macos/designated-requirements.txt and commit that file.
  3. GitHub: put MACOS_CERTIFICATE_P12_BASE64 (base64 -i $P12 | pbcopy), MACOS_CERTIFICATE_PASSWORD and
     MACOS_SIGNING_IDENTITY = $SHA1 into the \`release\` ENVIRONMENT (Settings, Environments, release:
     tags only, required reviewers), not into repository secrets.
  4. Delete the .p12 from this folder once it is backed up; this script never imports it anywhere
     unless you passed --import-to.
EOF
