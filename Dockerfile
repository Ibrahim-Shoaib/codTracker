# Pinned to a specific patch version because Railway's Metal builder
# repeatedly hangs on floating tags when Docker Hub is slow — a static tag
# lets the layer cache do its job. 20.19.6 satisfies package.json's
# engines range (>=20.19 <22). Bump intentionally on security fixes.

# ── Build stage — full dependency set, produces build/ ─────────────────────
FROM node:20.19.6-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci && npm cache clean --force
COPY . .
ENV NODE_ENV=production
RUN npm run build

# ── Runtime stage — prod deps + build output only ──────────────────────────
# No source, no dev tooling, no scripts/ — roughly half the single-stage
# image size and a much smaller attack surface.
FROM node:20.19.6-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/build ./build

EXPOSE 3000

# Drop root — remix-serve needs no filesystem writes.
USER node

# Container-level probe (Railway also polls /healthz via healthcheckPath).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

CMD ["npm", "run", "docker-start"]
