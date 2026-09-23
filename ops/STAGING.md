# ops/STAGING.md — staging environment guide

A staging environment for Vyaya is the full compose stack with real
identity and a managed database. Everything below is wired already; this
is the order to do it in.

## Shape

| Piece | Staging choice | Why |
| --- | --- | --- |
| Database | Neon (real `DATABASE_URL`) | Prod parity; the dev Postgres container is for laptops. |
| Identity | Real DeskId (`deskid` compose profile) | OAuth round trips against the real thing; mock-deskid never leaves dev. |
| Upstream | mock-openai, or real OpenAI with a low-budget key | Staging traffic is synthetic; the mock's failure injection is useful. |
| Redis | compose redis:7-alpine | Rate limiting + job locks; persistent enough for staging. |
| Flags | All off, then flipped deliberately | Staging is where flags get exercised before prod. |

## Bring-up

1. **Database.** Create the Neon project. Set `DATABASE_URL` to it.
   Create the roles and apply migrations:
   `pnpm --filter @vyaya/db exec tsx src/migrate.ts` (or the compose
   first-run checklist in `docs/DEPLOY.md`). Migrations 0000-0004 include
   the RLS roles (`vyaya_app`, `vyaya_service`).
2. **DeskId.** `scripts/deskid-keygen.sh` to mint the RSA pair into
   `./.deskid/`. Set `DESKID_ISSUER` to the staging issuer URL and keep it
   identical on both sides. Provide Google/GitHub OAuth client credentials
   (`DESKID_GOOGLE_CLIENT_ID/SECRET`, `DESKID_GITHUB_CLIENT_ID/SECRET`)
   with the staging callback `AUTH_SPA_CALLBACK_URL` registered at the
   provider.
3. **Compose profiles.** `COMPOSE_PROFILES=deskid` in `.env`. Set the
   internal URLs: `DESKID_JWKS_URL_INTERNAL=http://deskid:8090/.well-known/jwks.json`,
   `DESKID_BASE_URL_INTERNAL=http://deskid:8090`.
4. **Secrets.** Real `SESSION_COOKIE_SECRET` (32+ bytes) and
   `MASTER_ENCRYPTION_KEY` (`openssl rand -hex 32`). The `.env.example`
   placeholder key is all zeros — config accepts it, ops policy doesn't.
5. **Up.** `docker compose up --build`. Verify: web on 3000 redirects to
   DeskId login, the OAuth round trip lands on `/onboarding`, a test
   request through the proxy logs a `request_logs` row, one-shot classify
   produces waste events.

## Seed policy

- **Staging: yes, seeded.** Run `packages/db` seed for the demo workspace
  (194 request logs engineered to fire all five detectors). It's how
  screenshots, demos, and QA of the dashboard happen without weeks of
  traffic. Label seeded workspaces clearly ("Acme" in the seed).
- **Prod: never.** The seed inserts synthetic request logs and waste
  events; in prod that pollutes real tenant data and the audit trail.
- The seed is idempotent (second run inserts nothing, prints no keys), so
  re-running it in staging is safe.

## Flag exercises worth doing in staging

- `LOG_BODIES=true` + workspace opt-in: verify bodies land encrypted in
  `request_bodies` and disappear after `BODY_RETENTION_DAYS` (force the
  sweeper with a one-shot run and a tiny retention window).
- `STRIPE_ENABLED=true` with a test key: verify outbox rows flip to
  `sent`.
- `SENTINEL_ENABLED=true` with a collector: verify spans arrive.
- `DESKID_RECONCILE_ENABLED=true`: create a user in DeskId, watch
  `user_grants_cache` update within `DESKID_RECONCILE_INTERVAL_MS`.

## Promoting to prod

1. Same migrations, fresh Neon project. Never restore staging data into
   prod — the seed rule above is why.
2. New secrets everywhere (session, master key, DeskId keypair). The
   staging master key must never encrypt prod bodies.
3. `AUTH_MODE=deskid` everywhere; the mock-deskid profile stays off.
4. Real `OPENAI_BASE_URL` + `OPENAI_API_KEY` (or KubeMind router).
5. Walk the `docs/DEPLOY.md` production checklist; confirm the flags-off
   list matches what you actually want on.
