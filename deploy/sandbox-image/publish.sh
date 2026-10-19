#!/usr/bin/env bash
# Build, push and sign the sandbox image for linux/arm64 and linux/amd64, then record the
# digests in versions.json. Meant for a release job with registry credentials and an OIDC
# identity (cosign keyless); it has not been run yet (no image is published).
#
# Usage: ./publish.sh [core|base|full ...]     (default: base full)
# Needs: docker buildx, cosign, jq.
set -euo pipefail
cd "$(dirname "$0")"

repo=$(jq -r .repository versions.json)
platforms=$(jq -r '.platforms | join(",")' versions.json)
variants=("$@")
[ ${#variants[@]} -eq 0 ] && variants=(base full)

for v in "${variants[@]}"; do
  tag=$(jq -r --arg v "$v" '.variants[$v].tag' versions.json)
  [ "$tag" = null ] && { echo "unknown variant $v" >&2; exit 2; }
  echo "building $repo:$tag ($v) for $platforms" >&2
  docker buildx build --platform "$platforms" --target "$v" \
    --provenance=mode=max --sbom=true \
    --tag "$repo:$tag" --push --metadata-file "/tmp/psyche-sandbox-$v.json" .
  digest=$(jq -r '."containerimage.digest"' "/tmp/psyche-sandbox-$v.json")
  cosign sign --yes "$repo@$digest"
  tmp=$(mktemp)
  jq --arg v "$v" --arg d "$digest" '.variants[$v].digest = $d' versions.json > "$tmp"
  mv "$tmp" versions.json
  echo "$v -> $repo@$digest (signed)" >&2
done

# Verify before anyone pins it:
#   cosign verify "$repo@<digest>" \
#     --certificate-identity-regexp "$(jq -r .signing.certificateIdentityRegexp versions.json)" \
#     --certificate-oidc-issuer "$(jq -r .signing.certificateOidcIssuer versions.json)"
