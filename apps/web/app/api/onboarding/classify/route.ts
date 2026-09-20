import { runClassifierNow } from "@/lib/bff/onboarding";
import { getEnv } from "@/lib/env";
import { forbidden } from "@/lib/errors";
import { requireSession, respond } from "@/lib/http";

/**
 * DEV ONLY: run the worker's classifier immediately
 * (`--job classify --once`) so the first-waste moment doesn't wait for the
 * nightly schedule. In production (AUTH_MODE=deskid) this returns 403; the
 * worker runs on its own schedule there.
 */
export async function POST() {
  return respond(async () => {
    await requireSession();
    const env = getEnv();
    if (env.auth.mode !== "dev") {
      throw forbidden("the classifier runs on a schedule in production");
    }
    return await runClassifierNow({ workerCliPath: env.workerCliPath });
  });
}
