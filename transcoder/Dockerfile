FROM node:20-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── Runtime ───────────────────────────────────────────────────────────────────
FROM node:20-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY package*.json ./
RUN npm install --omit=dev

# Pre-create output directories
RUN mkdir -p /output/1080p /output/720p /output/480p

EXPOSE 1935 3001 3002

CMD ["node", "dist/index.js"]
