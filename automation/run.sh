#!/usr/bin/env bash
# Hourly wrapper: unfollow up to N (default 15) non-blue-V accounts (mutual or not; blue-V never).
unset NPM_CONFIG_PREFIX
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 22 >/dev/null
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "${X_AUTOMATION_DIR:-/workspace/x-unfollow}"
# honour the on/off toggle in automation.config.json (序帖 → 自动化)
if node -e 'try{const c=JSON.parse(require("fs").readFileSync("automation.config.json","utf8"));process.exit(c.unfollow&&c.unfollow.enabled===false?0:1)}catch{process.exit(1)}'; then
  echo "[$(date -u +%FT%TZ)] unfollow disabled in automation.config.json; skipping" >> run.out; exit 0
fi
node --no-warnings "$HERE/unfollow.mjs" "${1:-15}" >> run.out 2>&1
