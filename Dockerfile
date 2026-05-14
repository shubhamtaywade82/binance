# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:22-alpine

RUN addgroup -S botgroup && adduser -S botuser -G botgroup

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist/ dist/

RUN mkdir -p logs paper data && chown -R botuser:botgroup /app

USER botuser

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:9090/metrics || exit 1

EXPOSE 9090

CMD ["node", "dist/index.js"]
