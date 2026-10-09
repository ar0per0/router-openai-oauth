FROM node:22.23.3-bookworm-slim

WORKDIR /app
RUN mkdir -p -m 0700 /app/data && chown node:node /app/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node src ./src

ENV HOST=0.0.0.0 \
    PORT=10530 \
    TZ=Etc/UTC \
    UPSTREAMS=http://127.0.0.1:10531 \
    UPSTREAM_TIMEOUT_MS=180000 \
    UPSTREAM_FAILURE_THRESHOLD=3 \
    CLIENT_ERROR_FAILURE_THRESHOLD=5 \
    RUNTIME_FAILOVER=false \
    UPSTREAM_COOLDOWN=10m \
    MAX_REQUEST_BODY_BYTES=33554432 \
    RETRY_STATUS_CODES=401,403,408,429,500-599 \
    ROUTER_API_KEY=

USER node

EXPOSE 10530

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/health', { signal: AbortSignal.timeout(4000) }).then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

ENTRYPOINT ["node", "src/index.mjs"]
