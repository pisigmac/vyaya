import { z } from "zod";
import { getReportPdf } from "@/lib/bff/reports";
import { getDb } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { requireSession, respond } from "@/lib/http";

const idSchema = z.uuid();

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const session = await requireSession();
    const id = idSchema.parse((await ctx.params).id);
    const pdf = await getReportPdf(
      getDb().db,
      session,
      id,
      getEnv().reportOutputDir,
    );
    return new Response(new Uint8Array(pdf.bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${pdf.filename}"`,
      },
    });
  });
}
