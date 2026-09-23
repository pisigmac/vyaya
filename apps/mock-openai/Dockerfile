# syntax=docker/dockerfile:1
# apps/mock-openai — deterministic dev upstream. Dev double; not wired into
# any production compose path.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @vyaya/mock-openai... build \
  && pnpm deploy --legacy --filter @vyaya/mock-openai --prod /prod

FROM node:24-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod ./
USER node
EXPOSE 8788
CMD ["node", "dist/index.js"]
