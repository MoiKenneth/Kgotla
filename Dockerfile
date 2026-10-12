# Kgotla API + web apps in one small image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci
COPY apps/api apps/api
RUN npm run build -w apps/api && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 WEB_DIR=/app/apps/web
WORKDIR /app
RUN addgroup -S kgotla && adduser -S kgotla -G kgotla
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
COPY apps/web apps/web
USER kgotla
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/health || exit 1
CMD ["node", "apps/api/dist/src/server.js"]
