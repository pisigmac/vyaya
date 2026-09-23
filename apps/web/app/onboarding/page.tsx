import { redirect } from "next/navigation";
import { listApiKeys } from "@/lib/bff/keys";
import { getFlowState } from "@/lib/bff/stats";
import { getWorkspaceSettings } from "@/lib/bff/settings";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getSession } from "@/lib/http";
import { OnboardingFlow } from "@/components/onboarding-flow";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await getSession().catch(() => null);
  if (!session) redirect("/login?next=/onboarding");

  const db = getDb().db;
  const env = getEnv();
  const [settings, flow, keys] = await Promise.all([
    getWorkspaceSettings(db, session),
    getFlowState(db, session),
    listApiKeys(db, session),
  ]);

  return (
    <div className="pt-8">
      <div className="max-w-2xl">
        <h1 className="text-title font-semibold">
          Five minutes to your first wasted dollar.
        </h1>
        <p className="mt-3 text-body text-muted">
          Workspace ready: {settings.name}. Three steps and the dashboard
          starts talking.
        </p>
      </div>
      <OnboardingFlow
        proxyBaseUrl={env.proxyBaseUrl}
        authMode={env.auth.mode}
        canWrite={session.role !== "viewer"}
        activeKeyCount={keys.filter((k) => k.revokedAt === null).length}
        initialRequestCount={flow.requestCount}
        initialWasteEventCount={flow.wasteEventCount}
      />
    </div>
  );
}
