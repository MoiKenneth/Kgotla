import Anthropic from '@anthropic-ai/sdk';
import { assertConfig, config } from './config.js';
import { buildApp } from './app.js';
import { createPool } from './db.js';
import { MemorySms, processOutbox } from './lib/notify.js';
import { migrate } from './migrate.js';
import { seedDemo, seedReference } from './seed.js';

assertConfig();
const pool = createPool();
await migrate(pool);
await seedReference(pool);
if (config.demoMode) await seedDemo(pool);

const llm = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;
const app = await buildApp({ pool, llm, logger: true });

// Development SMS gateway logs messages. Swap for a real gateway adapter in a pilot.
const sms = new MemorySms((m) => app.log.info(m));
const timer = setInterval(() => processOutbox(pool, sms).catch((e) => app.log.error(e)), config.outboxIntervalMs);

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ port: config.port, host: config.host });
app.log.info(`Kgotla API on :${config.port} · demo mode ${config.demoMode ? 'ON' : 'off'} · assistant ${llm ? config.anthropicModel : 'rules (no ANTHROPIC_API_KEY)'}`);
