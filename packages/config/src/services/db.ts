import { z } from "zod";
import {
  hexKey32Field,
  nodeEnvField,
  optionalString,
  portField,
  postgresUrlField,
} from "../shared.js";

export const dbEnvSchema = z
  .object({
    NODE_ENV: nodeEnvField,
    DATABASE_URL: postgresUrlField,
    POSTGRES_USER: z.string().default("vyaya"),
    POSTGRES_PASSWORD: z.string().default("vyaya"),
    POSTGRES_DB: z.string().default("vyaya"),
    POSTGRES_PORT: portField(5432),
    /**
     * Optional here (required by proxy/worker schemas): the seed script uses
     * it to encrypt demo request bodies for workspaces with body logging
     * enabled. Absent = seed skips body rows.
     */
    MASTER_ENCRYPTION_KEY: optionalString.pipe(hexKey32Field.optional()),
  })
  .transform((env) => ({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    postgres: {
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
      port: env.POSTGRES_PORT,
    },
    masterEncryptionKey: env.MASTER_ENCRYPTION_KEY ?? null,
  }));

export type DbEnv = z.output<typeof dbEnvSchema>;

export function loadDbEnv(source: NodeJS.ProcessEnv = process.env): DbEnv {
  return dbEnvSchema.parse(source);
}
