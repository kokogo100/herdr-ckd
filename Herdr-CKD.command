#!/usr/bin/env bash
# Herdr CKD — macOS (Apple Silicon Apple Silicon 등) 더블클릭 실행 스크립트 (.command)
set -euo pipefail

APP_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NVM_NODE="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1 || true)"
  if [ -n "$LATEST_NVM_NODE" ]; then
    export PATH="$HOME/.nvm/versions/node/$LATEST_NVM_NODE/bin:$PATH"
  fi
fi

export HERDR_APP_ROOT="$APP_ROOT"

if [ ! -f "$APP_ROOT/dist/src/ui-server.js" ]; then
  echo "[Herdr CKD] dist/ 빌드가 없어 TypeScript 빌드를 시작합니다..."
  npm run build
fi

exec node "$APP_ROOT/dist/src/ui-server.js" "$@"
