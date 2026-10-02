import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  NEO4J_URI: z.string().default('bolt://127.0.0.1:7687'),
  NEO4J_USERNAME: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default('sih_graph_dev_password'),
  NEO4J_DATABASE: z.string().default('neo4j'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  EVIDENCE_STORAGE_PATH: z.string().default('./storage/evidence'),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast and loudly — a misconfigured env must never limp along silently.
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration. See errors above.');
  }
  return parsed.data;
}

export const env = loadEnv();
export type Env = typeof env;
