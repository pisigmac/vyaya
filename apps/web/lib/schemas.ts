import { z } from "zod";
import { WASTE_TYPES } from "@vyaya/core";

/**
 * Zod schemas for every BFF input boundary (query strings and JSON bodies).
 * Nothing enters a route handler without passing through one of these.
 */

export const callbackQuerySchema = z.object({
  token: z.string().min(1),
  provider: z.enum(["github", "google"]).optional(),
});

export const createKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
});

export const testRequestBodySchema = z.object({
  apiKey: z
    .string()
    .regex(
      /^vy_live_[0-9a-f]{64}$/,
      "expected a vy_live_ key (paste the full key shown once at creation)",
    ),
});

export const featureTagSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-_]{0,63}$/,
    "tags are lowercase letters, digits, dashes and underscores",
  );

export const updateWorkspaceBodySchema = z
  .object({
    logBodiesEnabled: z.boolean().optional(),
    reportEmail: z
      .union([z.email(), z.literal(""), z.null()])
      .optional(),
    featureTags: z.array(featureTagSchema).max(50).optional(),
  })
  .refine(
    (v) =>
      v.logBodiesEnabled !== undefined ||
      v.reportEmail !== undefined ||
      v.featureTags !== undefined,
    { message: "nothing to update" },
  );

const pageField = z.coerce.number().int().min(1).default(1);
const pageSizeField = z.coerce.number().int().min(1).max(100).default(20);

export const wasteEventsQuerySchema = z.object({
  page: pageField,
  pageSize: pageSizeField,
  sort: z.enum(["dollars", "recent"]).default("dollars"),
  wasteType: z.enum(WASTE_TYPES).optional(),
});

export const breakdownQuerySchema = z.object({
  dimension: z.enum(["waste_type", "endpoint", "feature_tag"]).default("waste_type"),
  days: z.coerce.number().int().min(1).max(90).default(30),
});

export const trendQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).default(30),
});

export const reportsQuerySchema = z.object({
  page: pageField,
  pageSize: pageSizeField,
});

export type UpdateWorkspaceBody = z.infer<typeof updateWorkspaceBodySchema>;
export type WasteEventsQuery = z.infer<typeof wasteEventsQuerySchema>;
export type BreakdownQuery = z.infer<typeof breakdownQuerySchema>;
export type BreakdownDimension = BreakdownQuery["dimension"];
