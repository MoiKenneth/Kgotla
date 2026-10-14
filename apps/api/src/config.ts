// Runtime configuration. Everything comes from environment variables so the
// same build runs in every country cell; see .env.example for the full list.

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

const env = process.env;
const production = env.NODE_ENV === 'production';
/** Running in a hosted cell (Azure): secrets are mandatory even for demo cells. */
const cloud = bool(env.KGOTLA_CLOUD, false);
const optional = (v: string | undefined) => (v && v !== 'unset' ? v : '');

export const config = {
  production,
  cloud,
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  /** Empty when the standard PGHOST/PGUSER/PGDATABASE variables are used instead (Azure). */
  databaseUrl: env.DATABASE_URL ?? (env.PGHOST ? '' : 'postgres://postgres:postgres@localhost:5432/kgotla'),
  /** 'entra': sign in to PostgreSQL with the managed identity (no password). 'password': classic. */
  dbAuth: (env.PGAUTH === 'entra' ? 'entra' : 'password') as 'entra' | 'password',
  /** Client ID of the user-assigned managed identity (Azure). */
  azureClientId: env.AZURE_CLIENT_ID ?? '',
  /** HMAC key for identifier hashing, share tokens and signed disclosures. 32+ random bytes. */
  secret: env.KGOTLA_SECRET ?? (production || cloud ? '' : 'dev-only-insecure-secret-change-me-0123456789'),
  /** Demo mode: returns OTPs in API responses and labels everything as example data. Never in a real pilot. */
  demoMode: bool(env.DEMO_MODE, !production),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
  actionTtlMinutes: Number(env.ACTION_TTL_MINUTES ?? 10),
  pinMaxFailures: Number(env.PIN_MAX_FAILURES ?? 5),
  pinLockMinutes: Number(env.PIN_LOCK_MINUTES ?? 15),
  /** Public address. Render sets RENDER_EXTERNAL_URL automatically. */
  publicBaseUrl: (env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || 'http://localhost:8080').replace(/\/$/, ''),
  anthropicApiKey: optional(env.ANTHROPIC_API_KEY),
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-haiku-5-5',
  outboxIntervalMs: Number(env.OUTBOX_INTERVAL_MS ?? 2000),
  webDir: env.WEB_DIR ?? '',
  /** Country pack for this cell: BW, ZA, NA, ZM or ZW. */
  country: (env.KGOTLA_COUNTRY ?? 'BW').toUpperCase(),
  /**
   * How sign-up checks identity. 'mock': the demo registry. 'open': no registry
   * link yet, so people declare their details, prove their phone by SMS and get
   * assurance level 2 (government services that need level 3 stay locked).
   */
  registryMode: (env.REGISTRY_MODE ?? (bool(env.DEMO_MODE, !production) ? 'mock' : 'open')) as 'mock' | 'open',
  paypal: {
    clientId: optional(env.PAYPAL_CLIENT_ID),
    clientSecret: optional(env.PAYPAL_CLIENT_SECRET),
    /** 'sandbox' (test money) or 'live'. */
    env: (env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox') as 'sandbox' | 'live',
    /** PayPal does not settle in BWP, ZAR, NAD or ZMW: charges are made in this currency. */
    currency: env.PAYPAL_CURRENCY ?? 'USD',
    /** Local currency units per 1 unit of PAYPAL_CURRENCY. Empty = the country pack's default. */
    fxRate: Number(env.PAYPAL_FX_RATE ?? 0) || 0,
  },
  dpo: {
    companyToken: optional(env.DPO_COMPANY_TOKEN),
    serviceType: optional(env.DPO_SERVICE_TYPE),
    apiUrl: env.DPO_API_URL ?? 'https://secure.3gdirectpay.com/API/v6/',
    payUrl: env.DPO_PAY_URL ?? 'https://secure.3gdirectpay.com/payv2.php?ID=',
  },
  twilio: {
    accountSid: optional(env.TWILIO_ACCOUNT_SID),
    authToken: optional(env.TWILIO_AUTH_TOKEN),
    from: optional(env.TWILIO_FROM),
    messagingServiceSid: optional(env.TWILIO_MESSAGING_SERVICE_SID),
  },
};

export function assertConfig(): void {
  if (config.cloud && (!config.secret || config.secret.length < 32)) {
    throw new Error('KGOTLA_SECRET must be set to at least 32 characters in a hosted cell');
  }
  if (config.production) {
    if (!config.secret || config.secret.length < 32) {
      throw new Error('KGOTLA_SECRET must be set to at least 32 characters in production');
    }
    if (config.demoMode) {
      throw new Error('DEMO_MODE must be off in production');
    }
  }
}
