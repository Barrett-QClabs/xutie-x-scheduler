#!/usr/bin/env bash
# Idempotent: starts the follow-back daemon unless it is already running.
HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
cd "${X_AUTOMATION_DIR:-/workspace/x-unfollow}"
if [ -f followback.lock ] && kill -0 "$(cat followback.lock)" 2>/dev/null; then
  echo "followback already running (pid $(cat followback.lock))"; exit 0
fi
unset NPM_CONFIG_PREFIX
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null; nvm use 22 >/dev/null
nohup node --no-warnings "$HERE/followback.mjs" >> followback.out 2>&1 &
echo "followback started (pid $!)"
