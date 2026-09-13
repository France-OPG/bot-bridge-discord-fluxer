# Build stage — TypeScript
FROM node:22-bookworm-slim AS build
WORKDIR /app

# pnpm pour reproduire l'installation exacte du package.json
RUN corepack enable

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile=false

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Runtime stage — minimal, sans sources ni devDependencies
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Addons su système nécessaires aux modules natifs (@discordjs/opus, rtc-node)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable \
  && pnpm install --prod --frozen-lockfile=false

COPY --from=build /app/dist ./dist

# Configuration et données persistées (montées via volumes)
RUN mkdir -p /app/config /app/data
ENV BRIDGE_CONFIG=/app/config/config.yaml

EXPOSE 8083
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:8083/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node
CMD ["node", "dist/index.js"]