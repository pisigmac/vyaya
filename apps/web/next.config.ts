import type { NextConfig } from "next";

/**
 * Security headers applied to every response. CSP allows inline scripts and
 * styles because Next.js injects both (theme bootstrap, framework runtime);
 * everything else is locked to same-origin. No external origins are needed:
 * fonts are self-hosted by next/font.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep only the native/driver packages external (argon2 ships a prebuilt
  // N-API binary; postgres negotiates optional native bindings). The @vyaya/*
  // workspace packages are bundled — web imports their narrow subpaths
  // (@vyaya/db/client, /schema, /api-keys), never the barrel with migrate.js.
  serverExternalPackages: ["postgres", "@node-rs/argon2"],
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
