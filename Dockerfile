FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npm run build

FROM node:20-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/
RUN mkdir -p data logs
VOLUME ["/app/data", "/app/logs"]
CMD ["node", "dist/index.js"]