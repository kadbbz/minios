#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-${ROOT_DIR}/data}"

mkdir -p \
  "${TARGET_DIR}/config" \
  "${TARGET_DIR}/gateway/root/data/platform/templates" \
  "${TARGET_DIR}/gateway/root/data/platform/skills/global" \
  "${TARGET_DIR}/gateway/root/data/agents" \
  "${TARGET_DIR}/gateway/logs" \
  "${TARGET_DIR}/gateway/test-runs" \
  "${TARGET_DIR}/redis" \
  "${TARGET_DIR}/emqx/data" \
  "${TARGET_DIR}/emqx/log" \
  "${TARGET_DIR}/minio/data" \
  "${TARGET_DIR}/minio/config"

copy_if_missing() {
  local source_path="$1"
  local target_path="$2"
  if [[ ! -e "${target_path}" ]]; then
    cp "${source_path}" "${target_path}"
  fi
}

copy_if_missing "${ROOT_DIR}/config/llm.json" "${TARGET_DIR}/config/llm.json"
copy_if_missing "${ROOT_DIR}/config/env.json" "${TARGET_DIR}/config/env.json"

node "${ROOT_DIR}/scripts/render-runtime-env.mjs" "${TARGET_DIR}" >/dev/null

printf 'initialized compose data root: %s\n' "${TARGET_DIR}"
