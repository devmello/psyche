#!/usr/bin/env bash
# Cheap CI gate: fail if a tracked file contains an obvious credential.
# This is a placeholder until S18 wires the real secret-leak checker
# (packages/testing, docs/05-security-and-permissions.md). Keep patterns
# specific enough that docs and fixtures do not trip them; test fixtures that
# need secret-shaped strings should build them at runtime instead of committing them.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

patterns=(
  'sk-ant-[A-Za-z0-9_-]{20,}'                # Anthropic API key
  'sk-(proj-)?[A-Za-z0-9]{32,}'              # OpenAI-style API key
  'gh[pousr]_[A-Za-z0-9]{36,}'               # GitHub token
  'github_pat_[A-Za-z0-9_]{40,}'             # GitHub fine-grained token
  'AKIA[0-9A-Z]{16}'                         # AWS access key id
  'AIza[0-9A-Za-z_-]{35}'                    # Google API key
  'xox[abpr]-[A-Za-z0-9-]{10,}'              # Slack token
  '[0-9]{8,10}:AA[A-Za-z0-9_-]{33}'          # Telegram bot token
  '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'    # PEM private key
  '[a-z][a-z0-9+.-]*://[^/[:space:]:@"'\''<>]+:[^/[:space:]@"'\''<>]{3,}@[A-Za-z0-9.-]+' # credentials in a URL
)

regex="$(IFS='|'; echo "${patterns[*]}")"

# Tracked text files only; skip the lockfile and vendored or generated trees.
matches="$(git ls-files -z -- . ':!:pnpm-lock.yaml' ':!:**/generated/**' \
  | xargs -0 grep -I -H -n -E -- "$regex" 2>/dev/null || true)"

if [ -n "$matches" ]; then
  echo "::error::Possible secrets found in tracked files:"
  # Print file:line only, never the matched value.
  echo "$matches" | cut -d: -f1,2
  exit 1
fi

echo "secret grep gate: no obvious secrets found"
