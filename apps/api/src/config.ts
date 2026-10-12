// Runtime configuration. Everything comes from environment variables so the
// same build runs in every country cell; see .env.example for the full list.

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const env = process.env;
const production = env.NODE_ENV === 'production';

export const config = {
  production,
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/kgotla',
  /** HMAC key for identifier hashing, share tokens and signed disclosures. 32+ random bytes. */
  secret: env.KGOTLA_SECRET ?? (production ? '' : 'dev-only-insecure-secret-change-me-0123456789'),
  /** Demo mode: returns OTPs in API responses and labels everything as example data. Never in a real pilot. */
  demoMode: bool(env.DEMO_MODE, !production),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
  actionTtlMinutes: Number(env.ACTION_TTL_MINUTES ?? 10),
  pinMaxFailures: Number(env.PIN_MAX_FAILURES ?? 5),
  pinLockMinutes: Number(env.PIN_LOCK_MINUTES ?? 15),
  publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:8080',
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-haiku-5-5',
  outboxIntervalMs: Number(env.OUTBOX_INTERVAL_MS ?? 2000),
  webDir: env.WEB_DIR ?? '',
  country: env.KGOTLA_COUNTRY ?? 'BW',
  currency: env.KGOTLA_CURRENCY ?? 'BWP',
};

export function assertConfig(): void {
  if (config.production) {
    if (!config.secret || config.secret.length < 32) {
      throw new Error('KGOTLA_SECRET must be set to at least 32 characters in production');
    }
    if (config.demoMode) {
      throw new Error('DEMO_MODE must be off in production');
    }
  }
}
