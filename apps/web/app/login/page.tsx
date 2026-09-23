import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Sign-in. Both buttons go straight to DeskId's OAuth start endpoints (the
 * mock issuer in AUTH_MODE=dev), which redirect back to /auth/callback.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const env = getEnv();
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;
  const base = env.auth.deskIdBaseUrl.replace(/\/$/, "");

  return (
    <div className="pt-20">
      <div className="max-w-md">
        <h1 className="text-title font-semibold">Log in to Vyaya.</h1>
        <p className="mt-3 text-body text-muted">
          One account, one workspace, zero wasted tokens. Pick your provider.
        </p>
        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-accent bg-surface px-4 py-3 text-small text-accent"
          >
            That sign-in didn't complete. Try again — if it keeps failing, the
            token may have expired on the way back.
          </p>
        ) : null}
        <div className="mt-8 space-y-3">
          <a
            href={`${base}/v1/oauth/github/start`}
            className="block rounded-md bg-primary px-5 py-2.5 text-center text-body font-medium text-primary-ink shadow-(--shadow-interactive) hover:opacity-90"
          >
            Continue with GitHub
          </a>
          <a
            href={`${base}/v1/oauth/google/start`}
            className="block rounded-md border border-border bg-surface px-5 py-2.5 text-center text-body font-medium text-ink shadow-(--shadow-interactive) hover:border-muted"
          >
            Continue with Google
          </a>
        </div>
        <p className="mt-6 text-small text-muted">
          Identity runs through DeskId. We never see your provider password.
        </p>
      </div>
    </div>
  );
}
