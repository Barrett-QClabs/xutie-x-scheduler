#!/usr/bin/env bash
# Idempotent: starts the keyword auto-follow daemon unless it is already running.
# Pool comes from keyword-candidates/*.json (free X plugin via write-keyword-pool.mjs);
# paid API is WRITE-only (NO_PAID_READS=1).
if [ -f /workspace/x-unfollow/KEYWORD_DISABLED ]; then echo "keywordfollow disabled by user (KEYWORD_DISABLED present)"; exit 0; fi
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "${X_AUTOMATION_DIR:-/workspace/x-unfollow}"
if [ -f keywordfollow.lock ] && kill -0 "$(cat keywordfollow.lock)" 2>/dev/null; then
  echo "keywordfollow already running (pid $(cat keywordfollow.lock))"; exit 0
fi
unset NPM_CONFIG_PREFIX
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 22 >/dev/null
export NO_PAID_READS=1
nohup env NO_PAID_READS=1 node --no-warnings "$HERE/keywordfollow.mjs" >> keywordfollow.out 2>&1 &
echo "keywordfollow started (pid $!)"
