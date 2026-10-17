# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @cloud-trigger/server deploy --prod --legacy /out \
 && cp -r apps/web/dist /out/web

FROM node:24-alpine AS runtime
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=8080 WEB_DIST=/app/web
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/health/live || exit 1
CMD ["node", "dist/main.js"]
