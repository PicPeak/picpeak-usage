FROM node:22-trixie-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
ENV npm_config_build_from_source=true
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --package-lock=false --no-audit --no-fund && mkdir -p /app/storage

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:4e4fb0ce55fd73901600796ef079a9490369d2515d7da31633a91608c82ca13b
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3190 DATABASE_PATH=/app/storage/usage.sqlite TRUST_PROXY_HOPS=1
COPY --from=build --chown=1000:1000 /app/package.json /app/package-lock.json ./
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/server ./server
COPY --from=build --chown=1000:1000 /app/protocol ./protocol
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/storage ./storage
# Keep the old non-root UID so existing usage-data volumes remain writable.
USER 1000:1000
EXPOSE 3190
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3190/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["server/index.js"]
