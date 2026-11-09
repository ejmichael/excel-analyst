import { z } from 'zod';

// Optional values may be empty in .env for now; later parts make them required.
const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().trim().min(1),
  CLIENT_URL: z.url(),
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().trim().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1),
  STORAGE_BUCKET_DATASETS: z.string().trim().min(1).default('datasets'),
  STORAGE_BUCKET_BRANDING: z.string().trim().min(1).default('branding'),
  ANTHROPIC_API_KEY: optional,
  ANTHROPIC_MODEL_PLANNER: optional,
  ANTHROPIC_MODEL_FAST: optional,
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(50),
  CRON_SECRET: optional,
  PAYFAST_SANDBOX: optional,
  PAYFAST_MERCHANT_ID: optional,
  PAYFAST_MERCHANT_KEY: optional,
  PAYFAST_PASSPHRASE: optional,
  PAYFAST_NOTIFY_URL: optional,
  PAYFAST_RETURN_URL: optional,
  PAYFAST_CANCEL_URL: optional,
});

export type Env = z.infer<typeof envSchema>;

/** Parses the environment and fails fast with a readable list of problems (never the values). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid server environment. Check server/.env:\n${lines.join('\n')}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Lazily loaded so unit tests can import modules without a .env file. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
