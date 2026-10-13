import Anthropic from '@anthropic-ai/sdk';
import { assertConfig, config } from './config.js';
import { useCountry } from './countries/index.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { MemorySms, processOutbox } from './lib/notify.js';
import { processWebhooks } from './lib/webhooks.js';
import { assertCell, migrate } from './migrate.js';
import { seedDemo, seedReference } from './seed.js';

assertConfig();
const pack = useCountry(config.country);
const pool = createPool();
await migrate(pool);
await assertCell(pool, pack.code);
await seedReference(pool);
if (config.demoMode) await seedDemo(pool);

const llm = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
const app = await buildApp({ pool, llm, logger: true });

// Development SMS gateway logs messages. Swap for a real gateway adapter in a pilot.
const sms = new MemorySms((m) => app.log.info(m));
const timer = setInterval(() => processOutbox(pool, sms).catch((e) => app.log.error(e)), config.outboxIntervalMs);
// Partner webhooks: signed, retried with back-off.
const hooks = setInterval(() => processWebhooks(pool).catch((e) => app.log.error(e)), Math.max(config.outboxIntervalMs, 3000));

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(hooks);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`Kgotla ${pack.name} cell on :${config.port} · demo mode ${config.demoMode ? 'ON' : 'off'} · assistant ${llm ? config.anthropicModel : 'rules (no ANTHROPIC_API_KEY)'}`);
