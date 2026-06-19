#!/usr/bin/env bash
# Print gcloud run --set-secrets value: ENV=PREFIX_ENV:latest,...
# Usage: ./scripts/gcp/cloudrun-set-secrets.sh dev-sui-booking
set -euo pipefail

PREFIX="${1:?secret prefix required, e.g. dev-sui-booking}"

pairs=()
while IFS= read -r name || [[ -n "$name" ]]; do
  [[ -z "$name" || "$name" =~ ^# ]] && continue
  pairs+=("${name}=${PREFIX}_${name}:latest")
done < deploy/secrets.list

(IFS=,; echo "${pairs[*]}")
