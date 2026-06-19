#!/usr/bin/env bash
# Upload .env values to Google Cloud Secret Manager (PREFIX_VAR per aappoint-api convention).
# Usage: GCP_PROJECT_ID=aappoint SECRET_PREFIX=dev-sui-booking ./scripts/gcp/upload-secrets-from-env.sh [.env]
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-aappoint}"
SECRET_PREFIX="${SECRET_PREFIX:-dev-sui-booking}"
ENV_FILE="${1:-.env}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "Set GCP_PROJECT_ID" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

gcloud config set project "$PROJECT_ID" >/dev/null

# shellcheck disable=SC1090
set -a
source <(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | sed 's/\r$//' | sed 's/[[:space:]]*$//')
set +a

while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" || "$name" =~ ^# ]] && continue

  value="${!name:-}"
  value="${value//$'\r'/}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ -z "$value" ]]; then
    echo "skip $name (empty)"
    continue
  fi
  if [[ "$value" =~ ^(your_|path/to/) ]]; then
    echo "skip $name (placeholder)"
    continue
  fi

  secret_name="${SECRET_PREFIX}_${name}"

  if ! gcloud secrets describe "$secret_name" >/dev/null 2>&1; then
    echo "create $secret_name"
    gcloud secrets create "$secret_name" --replication-policy=automatic >/dev/null
  else
    echo "update $secret_name"
  fi

  printf '%s' "$value" | gcloud secrets versions add "$secret_name" --data-file=- >/dev/null
done < deploy/secrets.list

echo "Done — secrets synced to $PROJECT_ID (prefix: ${SECRET_PREFIX}_)"
