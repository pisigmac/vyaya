# Vyaya

See what your LLM spend is actually buying.

Vyaya proxies your LLM traffic, classifies wasted spend into five waste types
(ghost output, retry storms, schema failure burn, context amnesia,
overprovisioned max tokens), and shows dollar figures plus concrete fixes per
type.

## Layout

- `apps/web` — dashboard (Next.js), port 3000
- `apps/proxy` — OpenAI-compatible observe-only proxy (Hono), port 8787
- `apps/worker` — nightly classifier + weekly report jobs, port 8790
- `apps/mock-openai` — deterministic dev upstream, port 8788
- `apps/mock-deskid` — dev-only RS256 JWT issuer, port 8091
- `packages/core` — detectors, cost math, envelope encryption, JWT verification, LogSink
- `packages/config` — zod-validated env for every service
- `packages/db` — Drizzle schemas, migrations, RLS

## Quick start

```sh
cp .env.example .env
pnpm install
pnpm build
pnpm test
```

Requires Node >= 22.12.0 and pnpm 10.17.1. Identity is DeskId (self-hosted);
in dev, `AUTH_MODE=dev` swaps in the mock issuer and runs the same
verification code path.

Full stack with Docker: `COMPOSE_PROFILES=mock-deskid docker compose up --build`.
Without Docker: `scripts/e2e-local.sh` runs the whole round trip (11
assertions) in user space.

## Documentation

Start at `docs/README.md` — it indexes every doc and gives reading orders
for engineers, operators, and go-to-market. Runbooks live in `ops/`.
The HTTP contract is `docs/API.md` + `docs/OPENAPI.yaml`; the rules of the
system are `docs/ARCHITECTURE.md`.
