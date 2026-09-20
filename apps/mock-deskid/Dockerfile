# syntax=docker/dockerfile:1
# apps/mock-deskid — DEV ONLY mock identity issuer. Requires AUTH_MODE=dev at
# runtime or it exits non-zero. Never referenced by any production path.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @vyaya/mock-deskid... build \
  && pnpm deploy --legacy --filter @vyaya/mock-deskid --prod /prod

FROM node:24-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod ./
# Key material lands here at boot when MOCK_DESKID_KEYS_DIR is left at its
# default (./keys); mount a volume to keep kids stable across restarts.
RUN mkdir -p /app/keys && chown node:node /app/keys
USER node
EXPOSE 8091
CMD ["node", "dist/index.js"]
