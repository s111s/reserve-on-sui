# ── Stage 1: build Vite frontend (VITE_* vars baked in at build time) ──
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# VITE_* build args — passed from GitLab CI after fetching from Secret Manager
ARG VITE_SUI_NETWORK
ARG VITE_FEE_RECEIVER_ADDRESS
ARG VITE_PACKAGE_ID
ARG VITE_COIN_PACKAGE_ID
ARG VITE_POINTS_LEDGER_ID
ARG VITE_TIER_REGISTRY_ID
ARG VITE_TIER_CONFIG_ID
ARG VITE_GOOGLE_CLIENT_ID

ENV VITE_SUI_NETWORK=$VITE_SUI_NETWORK \
    VITE_FEE_RECEIVER_ADDRESS=$VITE_FEE_RECEIVER_ADDRESS \
    VITE_PACKAGE_ID=$VITE_PACKAGE_ID \
    VITE_COIN_PACKAGE_ID=$VITE_COIN_PACKAGE_ID \
    VITE_POINTS_LEDGER_ID=$VITE_POINTS_LEDGER_ID \
    VITE_TIER_REGISTRY_ID=$VITE_TIER_REGISTRY_ID \
    VITE_TIER_CONFIG_ID=$VITE_TIER_CONFIG_ID \
    VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

RUN npm run build

# ── Stage 2: production runtime ────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install tsx --no-save

COPY --from=builder /app/dist ./dist
COPY src/server ./src/server
COPY data ./data

# Cloud Run sets PORT (default 8080); do not hardcode
EXPOSE 8080

CMD ["npx", "tsx", "src/server/index.ts"]
