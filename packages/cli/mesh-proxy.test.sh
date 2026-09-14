#!/usr/bin/env bash
# Regression: local relay calls must bypass shell proxy settings.
#
# Without curl --noproxy "*", this fails when http_proxy points to a dead local
# proxy because curl sends http://localhost:19800 through the proxy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESH_SH="$SCRIPT_DIR/mesh.sh"
RELAY_PORT="${MESH_RELAY_PORT:-19800}"
RELAY_URL="http://localhost:$RELAY_PORT"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if ! curl --noproxy "*" -sf "$RELAY_URL/api/status" >/dev/null 2>&1; then
  echo -e "${YELLOW}⊘ mesh proxy regression — relay not running at $RELAY_URL (skipped)${NC}"
  exit 0
fi

if output=$(
  http_proxy="http://127.0.0.1:9" \
  https_proxy="http://127.0.0.1:9" \
  HTTP_PROXY="http://127.0.0.1:9" \
  HTTPS_PROXY="http://127.0.0.1:9" \
  ALL_PROXY="http://127.0.0.1:9" \
  all_proxy="http://127.0.0.1:9" \
  NO_PROXY="" \
  no_proxy="" \
  MESH_RELAY_URL="$RELAY_URL" \
  bash "$MESH_SH" relay status
); then
  if echo "$output" | grep -q "\[mesh\] relay 运行中"; then
    echo -e "${GREEN}✓${NC} mesh relay status bypasses bad proxy settings"
    exit 0
  fi
  echo -e "${RED}✗${NC} mesh relay status succeeded but did not report relay running"
  echo "$output"
  exit 1
fi

echo -e "${RED}✗${NC} mesh relay status failed under bad proxy settings"
exit 1
