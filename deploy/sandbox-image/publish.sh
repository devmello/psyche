#!/usr/bin/env bash
# Build, push and sign the sandbox image variants for every platform in versions.json, then
# record each pushed manifest-list digest in versions.json (variants.<v>.digest).
#
# Run by the `sandbox-image` job of .github/workflows/release.yml on version tags (registry login
# and a GitHub OIDC token for cosign keyless). It is non-interactive and safe to run by hand with
# --dry-run, which prints the commands and needs only bash and jq.
#
# Usage: ./publish.sh [--dry-run] [--version X.Y.Z[-pre]] [core|base|full ...]
#   variants   default: $PSYCHE_SANDBOX_VARIANTS, else "core base full" (in that order, so each
#              target reuses the previous one's layers from the builder cache)
#   --version  default: $PSYCHE_SANDBOX_VERSION, else versions.json .version. Tags are
#              <version> for base and <version>-<variant> for the others.
#   --dry-run  also DRY_RUN=1. Prints what would run; does not touch versions.json.
# Needs (real run): docker buildx, cosign, jq, git.
set -euo pipefail
cd "$(dirname "$0")"

dry_run="${DRY_RUN:-0}"
version="${PSYCHE_SANDBOX_VERSION:-}"
variants=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --version) [ $# -ge 2 ] || { echo "--version needs a value" >&2; exit 2; }; version="$2"; shift ;;
    --version=*) version="${1#--version=}" ;;
    -h | --help) sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) variants+=("$1") ;;
  esac
  shift
done
if [ ${#variants[@]} -eq 0 ]; then
  read -r -a variants <<< "${PSYCHE_SANDBOX_VARIANTS:-core base full}"
fi

command -v jq > /dev/null || { echo "publish.sh needs jq" >&2; exit 2; }
if [ "$dry_run" != 1 ]; then
  for tool in docker cosign git; do
    command -v "$tool" > /dev/null || { echo "publish.sh needs $tool (or use --dry-run)" >&2; exit 2; }
  done
fi

run() {
  if [ "$dry_run" = 1 ]; then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

repo=$(jq -er .repository versions.json)
platforms=$(jq -er '.platforms | join(",")' versions.json)
[ -n "$version" ] || version=$(jq -er .version versions.json)
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "bad version '$version' (want X.Y.Z or X.Y.Z-pre)" >&2
  exit 2
fi

# Base images stay digest-pinned: versions.json is the source, the Dockerfile defaults must agree.
node_image=$(jq -er .baseImages.node versions.json)
uv_image=$(jq -er .baseImages.uv versions.json)
for pair in "NODE_IMAGE=$node_image" "UV_IMAGE=$uv_image"; do
  name="${pair%%=*}" ref="${pair#*=}"
  [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "$name '$ref' is not pinned by digest" >&2; exit 2; }
  grep -qxF "ARG $pair" Dockerfile || {
    echo "Dockerfile 'ARG $name=' default differs from versions.json baseImages; keep them in sync" >&2
    exit 2
  }
done

for v in "${variants[@]}"; do
  jq -e --arg v "$v" '.variants | has($v)' versions.json > /dev/null || {
    echo "unknown variant '$v' (versions.json has: $(jq -r '.variants | keys | join(" ")' versions.json))" >&2
    exit 2
  }
done

# Image config timestamps from the commit, not the wall clock (buildx reads SOURCE_DATE_EPOCH).
revision=$(git rev-parse HEAD 2> /dev/null || echo unknown)
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log -1 --format=%ct 2> /dev/null || echo 0)}"
export SOURCE_DATE_EPOCH

meta_dir=$(mktemp -d)
trap 'rm -rf "$meta_dir"' EXIT

for v in "${variants[@]}"; do
  if [ "$v" = base ]; then tag="$version"; else tag="$version-$v"; fi
  meta="$meta_dir/$v.json"
  echo "== $v: $repo:$tag for $platforms" >&2
  run docker buildx build \
    --platform "$platforms" \
    --target "$v" \
    --build-arg "NODE_IMAGE=$node_image" \
    --build-arg "UV_IMAGE=$uv_image" \
    --label "org.opencontainers.image.version=$tag" \
    --label "org.opencontainers.image.revision=$revision" \
    --provenance=mode=max \
    --sbom=true \
    --tag "$repo:$tag" \
    --push \
    --metadata-file "$meta" \
    .

  if [ "$dry_run" = 1 ]; then
    digest='sha256:dry-run'
  else
    digest=$(jq -r '."containerimage.digest" // empty' "$meta")
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "no digest in buildx metadata for $v" >&2; exit 1; }
  fi

  # Keyless: the certificate identity is this workflow run (versions.json .signing).
  run cosign sign --yes "$repo@$digest"

  if [ "$dry_run" = 1 ]; then
    echo "+ versions.json: .version = \"$version\", .variants.$v = {tag: \"$tag\", digest: \"$digest\"}" >&2
  else
    tmp=$(mktemp)
    jq --arg v "$v" --arg t "$tag" --arg d "$digest" --arg ver "$version" \
      '.version = $ver | .variants[$v].tag = $t | .variants[$v].digest = $d' versions.json > "$tmp"
    mv "$tmp" versions.json
  fi
  echo "== $v -> $repo@$digest (signed)" >&2
done

# Verify (the release workflow does this right after publishing):
#   cosign verify "$repo@<digest>" \
#     --certificate-identity-regexp "$(jq -r .signing.certificateIdentityRegexp versions.json)" \
#     --certificate-oidc-issuer "$(jq -r .signing.certificateOidcIssuer versions.json)"
