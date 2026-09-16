# ============================================================================
# API + worker image. One image, two entrypoints (D-002): Railway runs it twice
# with different start commands.
#   api    -> node apps/api/dist/server.js
#   worker -> node apps/api/dist/worker.js
# ============================================================================

FROM node:22-alpine AS builder
WORKDIR /app

# Copy manifests before sources so `npm ci` is cached across code-only changes.
# Every workspace manifest must be present or npm cannot resolve the workspace
# graph — including apps/web, which this image does not otherwise need.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/ai/package.json     packages/ai/
COPY apps/api/package.json        apps/api/
COPY apps/web/package.json        apps/web/

RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# Compiles .ts import specifiers to .js (see D-006), so the runtime stage is
# plain JavaScript and needs no TypeScript toolchain.
#
# `npm run`, never `npx`. npx will silently download an unrelated package named
# "tsc" from the registry when the local binary is not resolvable, exit 0, and
# emit nothing — producing an image that builds cleanly and crashes on start.
# `npm run` resolves from node_modules/.bin and fails loudly instead. (D-018)
RUN npm run build --workspace=@asc/shared \
 && npm run build --workspace=@asc/ai \
 && npm run build --workspace=@asc/api

# Refuse to ship an image whose compile produced nothing. Without this, an empty
# dist only surfaces as a crash loop after deployment.
RUN for d in packages/shared/dist packages/ai/dist apps/api/dist; do \
      [ -d "$d" ] || { echo "FATAL: $d missing after build"; exit 1; }; \
    done \
 && [ -f apps/api/dist/server.js ] || { echo "FATAL: server.js missing"; exit 1; } \
 && [ -f apps/api/dist/worker.js ] || { echo "FATAL: worker.js missing"; exit 1; }

# Drop dev dependencies from the tree the runtime stage inherits.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

# node_modules carries the workspace symlinks (@asc/shared -> packages/shared),
# so the dist output of each package has to land at its real path too.
COPY --from=builder --chown=node:node /app/package.json               ./package.json
COPY --from=builder --chown=node:node /app/node_modules               ./node_modules
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=node:node /app/packages/shared/dist       ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/ai/package.json   ./packages/ai/package.json
COPY --from=builder --chown=node:node /app/packages/ai/dist           ./packages/ai/dist
COPY --from=builder --chown=node:node /app/apps/api/package.json      ./apps/api/package.json
COPY --from=builder --chown=node:node /app/apps/api/dist              ./apps/api/dist

EXPOSE 8080

# Railway overrides this per service; it is the sensible default for `docker run`.
CMD ["node", "apps/api/dist/server.js"]
