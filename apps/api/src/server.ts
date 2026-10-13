import Anthropic from '@anthropic-ai/sdk';
import { assertConfig, config } from './config.js';
import { useCountry } from './countries/index.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { MemorySms, processOutbox, TwilioSms, type SmsGateway } from './lib/notify.js';
import { processWebhooks } from './lib/webhooks.js';
import { assertCell, migrate } from './migrate.js';
import { seedAdmin, seedDemo, seedReference } from './seed.js';

assertConfig();
const pack = useCountry(config.country);
const pool = createPool();
await migrate(pool);
await assertCell(pool, pack.code);
await seedReference(pool);
if (config.demoMode) await seedDemo(pool);
else await seedAdmin(pool);

const llm = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
const app = await buildApp({ pool, llm, logger: true });

// Real SMS through Twilio when configured; otherwise messages are only logged (demo and development).
const tw = config.twilio;
const sms: SmsGateway = tw.accountSid && tw.authToken && (tw.from || tw.messagingServiceSid)
  ? new TwilioSms({ accountSid: tw.accountSid, authToken: tw.authToken, from: tw.from, messagingServiceSid: tw.messagingServiceSid })
  : new MemorySms((m) => app.log.info(m));
if (!config.demoMode && sms instanceof MemorySms) app.log.warn('No SMS gateway configured: sign-up codes cannot reach people. Set TWILIO_* settings.');
const timer = setInterval(() => processOutbox(pool, sms).catch((e) => app.log.error(e)), config.outboxIntervalMs);
// Partner webhooks: signed, retried with back-off.
const hooks = setInterval(() => processWebhooks(pool).catch((e) => app.log.error(e)), Math.max(config.outboxIntervalMs, 3000));
// Payments whose return trip was lost: confirm with the provider once a minute.
const recon = setInterval(() => (app as any).reconcilePayments().catch((e: unknown) => app.log.error(e)), 60_000);

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(hooks);
  clearInterval(recon);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`Kgotla ${pack.name} cell on :${config.port} · demo mode ${config.demoMode ? 'ON' : 'off'} · sign-up ${config.registryMode} · SMS ${sms instanceof TwilioSms ? 'Twilio' : 'log only'} · payments ${[config.paypal.clientId ? `PayPal (${config.paypal.env})` : '', config.dpo.companyToken ? 'DPO Pay' : '', config.demoMode ? 'test' : ''].filter(Boolean).join(', ') || 'none'} · assistant ${llm ? config.anthropicModel : 'rules (no ANTHROPIC_API_KEY)'}`);
