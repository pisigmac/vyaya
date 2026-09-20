# @vyaya/mock-deskid — DEV ONLY

> **DEV ONLY.** This is a mock identity issuer for local development. It
> refuses to start unless `AUTH_MODE=dev`, it is never the default in any
> production path, and no production Dockerfile references it. Real
> deployments use DeskId (https://github.com/pisigmac/DeskId) behind
> `AUTH_MODE=deskid`. Mock and real DeskId run the *same* verification code
> in `@vyaya/core` — only key material and issuer differ.

Issues RS256 JWTs with the exact DeskId claim shape: `sub`, `email`,
`org_id`, `workspace_id`, `aud[]`, `roles: { "vyaya": "admin" | "operator" | "viewer" }`,
`token_version`, `iss`, `iat`, `exp`.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Liveness probe. |
| `GET /.well-known/jwks.json` | JWKS advertising current **and previous** RSA keys. |
| `GET /v1/oauth/google/start` | Dev OAuth stub: 302 redirect to `AUTH_SPA_CALLBACK_URL` with `?token=<jwt>&provider=google`. |
| `GET /v1/oauth/github/start` | Same, `provider=github`. |
| `POST /v1/dev/token` | Mint a token directly (tests, e2e, curl). Body fields optional: `sub`, `email`, `org_id`, `workspace_id`, `role`, `audiences`, `token_version`. |
| `POST /v1/admin/grants` | Auto-grant an audience: `{ "user_id", "audience" = "vyaya", "role" = "admin" }` → 201. |
| `GET /v1/admin/reconciliation/events?since_id=<n>` | In-memory event feed for the worker reconciliation job. |
| `POST /v1/admin/rotate-keys` | Rotate the signing key; previous key stays in the JWKS. |

OAuth stubs accept optional query overrides: `sub`, `email`, `org_id`,
`workspace_id`, `role`.

## Reconciliation event shape

```json
{
  "events": [
    {
      "id": 2,
      "type": "grant.created",
      "occurred_at": "2026-09-20T01:03:25.640Z",
      "data": { "user_id": "user-a", "audience": "kubemind", "role": "admin" }
    }
  ],
  "latest_id": 2
}
```

`id` is monotonic from 1 per process. Event types: `user.created` (first
token issuance for a `sub`), `grant.created` (POST /v1/admin/grants). The
feed is in-memory; a restart resets it, and consumers resync from
`since_id=0`.

## Keys

RSA-2048 keypair, generated at first boot and persisted under `keys/`
(gitignored, private key mode 0600) so restarts keep a stable `kid`.
`kid` = first 16 base64url chars of SHA-256 over the SPKI DER.

Override with `MOCK_DESKID_PRIVATE_KEY_PEM` + `MOCK_DESKID_PUBLIC_KEY_PEM`
(both required together; literal PEM or base64-encoded single line). Env
keys are never written to disk, and rotation stays in memory in that mode.

`POST /v1/admin/rotate-keys` promotes a fresh key and keeps the old one in
the JWKS, so clients with a warm `@vyaya/core` JWKS cache verify new tokens
via the unknown-kid refresh path while in-flight old tokens still pass.

## Run

```sh
AUTH_MODE=dev pnpm --filter @vyaya/mock-deskid build
AUTH_MODE=dev MOCK_DESKID_PORT=8091 node apps/mock-deskid/dist/index.js
```

The issuer claim defaults to `http://localhost:$MOCK_DESKID_PORT`; override
with `MOCK_DESKID_ISSUER` (or `DESKID_ISSUER` as a fallback).
