#!/bin/sh
set -e
# Run as PUID:PGID (Unraid: 99:100) and make sure /data is writable.
if [ "$(id -u)" = "0" ]; then
  PUID=${PUID:-99}; PGID=${PGID:-100}
  if ! getent group "$PGID" >/dev/null 2>&1; then addgroup -g "$PGID" ptgroup; fi
  GROUP=$(getent group "$PGID" | cut -d: -f1)
  if ! getent passwd "$PUID" >/dev/null 2>&1; then adduser -D -H -u "$PUID" -G "$GROUP" ptuser; fi
  USER_NAME=$(getent passwd "$PUID" | cut -d: -f1)
  mkdir -p "${PLAYTRACKER_DATA:-/data}"
  chown -R "$PUID:$PGID" "${PLAYTRACKER_DATA:-/data}" 2>/dev/null || true
  exec su-exec "$USER_NAME" "$@"
fi
exec "$@"
