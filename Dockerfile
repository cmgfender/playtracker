# Vestigo Media Tracker (formerly PlayTracker) - zero-dependency Node app (built-in SQLite, bundled ICU time zones).
# No packages are installed: the image builds offline and starts with no configuration.
FROM node:22-alpine

# The data folder default keeps its PlayTracker name on purpose: the app reads VESTIGO_DATA first,
# so a VESTIGO_DATA baked in here would silently beat the PLAYTRACKER_DATA of an existing install.
ENV NODE_ENV=production \
    PORT=7720 \
    PLAYTRACKER_DATA=/data \
    PUID=99 \
    PGID=100

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public

# Runs as root only long enough to chown /data, then drops to PUID:PGID (Unraid: 99:100).
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 7720

HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7720)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

LABEL org.opencontainers.image.title="Vestigo" \
      org.opencontainers.image.description="Vestigo Media Tracker (formerly PlayTracker) - self-hosted playtime and session tracker for Steam, Xbox and PlayStation" \
      org.opencontainers.image.source="https://github.com/cmgfender/playtracker" \
      org.opencontainers.image.licenses="MIT" \
      net.unraid.docker.webui="http://[IP]:[PORT:7720]/" \
      net.unraid.docker.icon="https://raw.githubusercontent.com/cmgfender/playtracker/main/public/icon-512.png"

# the commit the image was built from (set by CI), shown in health, diagnostics and the startup log
ARG REVISION=
ENV VESTIGO_REVISION=$REVISION

STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
