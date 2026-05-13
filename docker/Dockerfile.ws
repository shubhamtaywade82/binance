FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY gateway ./gateway
COPY src ./src
RUN npx tsc --outDir dist --rootDir .

FROM node:22-alpine
WORKDIR /app
RUN addgroup -S gw && adduser -S gw -G gw
COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/dist/gateway ./dist/gateway
COPY package.json ./
USER gw
HEALTHCHECK --interval=15s --timeout=3s CMD node -e "require('net').connect(Number(process.env.GATEWAY_PORT||4000),'localhost').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"
CMD ["node", "dist/gateway/ws-server.js"]
