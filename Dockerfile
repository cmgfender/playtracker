# PlayTracker — zero-dependency Node app (uses Node's built-in SQLite)
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    PLAYTRACKER_DATA=/data \
    TZ=UTC

RUN apk add --no-cache tzdata tini su-exec \
 && mkdir -p /data

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Unraid defaults: nobody:users (99:100). Override with PUID / PGID.
ENV PUID=99 PGID=100
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/v1/health >/dev/null || exit 1

LABEL org.opencontainers.image.title="PlayTracker" \
      org.opencontainers.image.description="Self-hosted game playtime & session tracker for Steam, Xbox and PlayStation" \
      org.opencontainers.image.source="https://github.com/cmgfender/playtracker" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
