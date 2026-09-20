# syntax=docker/dockerfile:1
# apps/web — Next.js 16 App Router + BFF route handlers. Standalone output,
# non-root. Port 3000.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @vyaya/web... build

# Next standalone tracing emits a self-contained server under
# apps/web/.next/standalone (mirrors the monorepo layout) — no pnpm deploy
# needed; the traced node_modules already include workspace packages.
FROM node:24-alpine AS run
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
