#!/usr/bin/env bash
# Idempotent: starts the follow-back daemon unless it is already running.
# Targets come from followback-targets.json (free X plugin); paid API is WRITE-only.
if [ -f /workspace/x-unfollow/FOLLOWBACK_DISABLED ]; then echo "followback disabled by user (2026-10-25)"; exit 0; fi
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "${X_AUTOMATION_DIR:-/workspace/x-unfollow}"
if [ -f followback.lock ] && kill -0 "$(cat followback.lock)" 2>/dev/null; then
  echo "followback already running (pid $(cat followback.lock))"; exit 0
fi
unset NPM_CONFIG_PREFIX
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 22 >/dev/null
export NO_PAID_READS=1
nohup env NO_PAID_READS=1 node --no-warnings "$HERE/followback.mjs" >> followback.out 2>&1 &
echo "followback started (pid $!)"
