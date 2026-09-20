# syntax=docker/dockerfile:1
# apps/proxy — observe-only LLM traffic proxy. Port 8787.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @vyaya/proxy... build \
  && pnpm deploy --legacy --filter @vyaya/proxy --prod /prod

FROM node:24-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod ./
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
