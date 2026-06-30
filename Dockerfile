# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ── deps: install all dependencies (incl. dev) for the build ─────────────────
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ── builder: build the Vite client (dist/) and bundle the Hono server ────────
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── prod-deps: production-only dependencies for the runtime image ─────────────
FROM base AS prod-deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── runner: minimal production image ─────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser

COPY --from=prod-deps --chown=appuser:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:nodejs /app/dist ./dist
COPY --from=builder --chown=appuser:nodejs /app/dist-server ./dist-server
COPY --chown=appuser:nodejs package.json ./

USER appuser
EXPOSE 3000

# Liveness probe — busybox wget ships with the alpine base image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "dist-server/index.mjs"]
