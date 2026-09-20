import { serve } from "@hono/node-server";
import { loadMockDeskIdEnv } from "@vyaya/config";
import { createApp, assertDevMode } from "./app.js";
import { loadKeyring } from "./keys.js";
import { MockDeskIdStore } from "./store.js";

/**
 * Entrypoint. DEV ONLY: refuses to boot unless AUTH_MODE=dev. All env access
 * goes through @vyaya/config.
 */
const env = loadMockDeskIdEnv();
assertDevMode(env.authMode);

const keyring = loadKeyring({
  keysDir: env.keysDir,
  privateKeyPem: env.privateKeyPem,
  publicKeyPem: env.publicKeyPem,
});
const app = createApp({
  issuer: env.issuer,
  spaCallbackUrl: env.spaCallbackUrl,
  tokenTtlSec: env.tokenTtlSec,
  keyring,
  store: new MockDeskIdStore(),
});

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(
    JSON.stringify({
      level: "info",
      service: "mock-deskid",
      msg: "DEV ONLY mock identity issuer listening",
      port: info.port,
      issuer: env.issuer,
      kid: keyring.keyring.current.kid,
    }),
  );
});
