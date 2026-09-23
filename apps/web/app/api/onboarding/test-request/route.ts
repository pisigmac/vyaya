import { sendTestRequest } from "@/lib/bff/onboarding";
import { getEnv } from "@/lib/env";
import { parseBody, requireSession, respond } from "@/lib/http";
import { testRequestBodySchema } from "@/lib/schemas";

/**
 * Send one real chat completion through the proxy using a key the caller
 * pastes (the one shown once at creation). The plaintext never touches the
 * database — it exists in this request only.
 */
export async function POST(request: Request) {
  return respond(async () => {
    await requireSession();
    const body = await parseBody(request, testRequestBodySchema);
    return await sendTestRequest({
      proxyBaseUrl: getEnv().proxyBaseUrl,
      apiKey: body.apiKey,
    });
  });
}
