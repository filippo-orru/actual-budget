# Build Actual's browser frontend and sync server inside Docker so no host-side
# Yarn installation or prebuilt artifacts are required.
FROM node:24-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

# Build dependencies in order, then focus production dependencies. 
# Workspace links are dereferenced because the runtime image omits /app/packages; 
# unused workspace files and source maps are pruned
# and the browser entrypoint is checked before finishing.
RUN yarn install --immutable \
    && yarn workspace plugins-service build \
    && yarn workspace @actual-app/crdt build \
    && yarn workspace @actual-app/core build \
    && yarn workspace @actual-app/web build:browser \
    && yarn workspace @actual-app/sync-server build \
    && yarn workspaces focus @actual-app/sync-server --production \
    && cp -RL node_modules node_modules.real \
    && rm -rf node_modules \
    && mv node_modules.real node_modules \
    && find node_modules/@actual-app/web -mindepth 1 -maxdepth 1 \
        ! -name build ! -name package.json -exec rm -rf {} + \
    && find node_modules/@actual-app/sync-server -mindepth 1 -maxdepth 1 \
        ! -name package.json -exec rm -rf {} + \
    && find node_modules -type f -name '*.map' -delete \
    && test -f node_modules/@actual-app/web/build/index.html

# Copy only runtime dependencies and outputs into a smaller image without build tools.
FROM node:24-bookworm-slim AS runtime

# tini forwards signals and reaps child processes; run Actual as a non-root user.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 actual \
    && useradd --uid 1001 --gid actual --create-home --shell /usr/sbin/nologin actual \
    && mkdir /data \
    && chown actual:actual /data

WORKDIR /app
ENV NODE_ENV=production

# Include production dependencies, package metadata for module resolution, and the compiled server.
COPY --from=builder --chown=actual:actual /app/node_modules ./node_modules
COPY --from=builder --chown=actual:actual /app/packages/sync-server/package.json ./package.json
COPY --from=builder --chown=actual:actual /app/packages/sync-server/build ./

# Keep compatibility with scripts that still resolve through /app/src/scripts.
RUN mkdir -p src && ln -s ../scripts src/scripts

USER actual
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
EXPOSE 5006
CMD ["node", "app.js"]
