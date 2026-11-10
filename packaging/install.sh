#!/bin/sh
# Install the already-built 序帖 image on this machine. Does not clone the repo.
# Generates CREDENTIALS_ENCRYPTION_KEY here if missing. The key is not in the image.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
IMAGE_TAR=${IMAGE_TAR:-"$ROOT/xuti-image.tar"}
NAME=${NAME:-xuti}
VOLUME=${VOLUME:-xuti-data}
KEY_FILE=${KEY_FILE:-"$ROOT/credentials.key"}
PORT=${PORT:-3847}

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if [ ! -f "$IMAGE_TAR" ]; then
  set -- "$ROOT"/xuti-image.tar.gz.part-*
  if [ -e "$1" ]; then
    cat "$ROOT"/xuti-image.tar.gz.part-* | gzip -dc > "$IMAGE_TAR"
  fi
fi

if [ ! -f "$IMAGE_TAR" ]; then
  echo "missing image archive: $IMAGE_TAR" >&2
  exit 1
fi

docker load -i "$IMAGE_TAR"

if [ ! -f "$KEY_FILE" ]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 > "$KEY_FILE"
  else
    dd if=/dev/urandom bs=32 count=1 2>/dev/null | base64 > "$KEY_FILE"
  fi
  chmod 600 "$KEY_FILE"
fi

docker volume create "$VOLUME" >/dev/null
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "container $NAME already exists; remove it yourself before reinstalling" >&2
  exit 1
fi

docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -p "127.0.0.1:${PORT}:3847" \
  -e X_API_MODE=mock \
  -e XUTIE_AUTOMATION_SUPERVISOR=off \
  -e HOST=0.0.0.0 \
  -e PORT=3847 \
  -e DATABASE_PATH=/data/xqueue.sqlite \
  -e CREDENTIALS_ENCRYPTION_KEY="$(tr -d '\n' < "$KEY_FILE")" \
  -v "${VOLUME}:/data" \
  xuti:0.1.0

echo "listening on http://127.0.0.1:${PORT}  (your browser, not the bot browser)"
echo "check: curl -sS http://127.0.0.1:${PORT}/api/state?accountId=1"
