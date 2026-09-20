# syntax=docker/dockerfile:1
# apps/worker — batch brain: classifier, weekly report, retention sweeper,
# DeskId reconciliation. Health endpoint on port 8790.

FROM node:24-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.17.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @vyaya/worker... build \
  && pnpm deploy --legacy --filter @vyaya/worker --prod /prod

FROM node:24-alpine AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod ./
# Report PDFs land here (REPORT_OUTPUT_DIR=/app/reports in compose); the dir
# must be node-writable so a fresh named volume inherits the ownership.
RUN mkdir -p /app/reports && chown node:node /app/reports
USER node
EXPOSE 8790
CMD ["node", "dist/index.js"]
