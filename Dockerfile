# syntax=docker/dockerfile:1
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
ENV NODE_ENV=production MCP_TRANSPORT=http PORT=3000 HOST=0.0.0.0
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz >/dev/null || exit 1
# tini forwards SIGTERM so graceful shutdown (drain + readiness 503) runs
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
