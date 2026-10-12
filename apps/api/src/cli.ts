// Operator commands for a real deployment (no demo data there).
//   npm run cli -w apps/api -- create-officer <username> "<Full Name>" <AGENCY> <caseworker|counter|admin>
//   npm run cli -w apps/api -- rotate-issuer-key <ISSUER_ID>
//   npm run cli -w apps/api -- verify-integrity
// create-officer prints a one-time password; the officer should change it at first sign-in (roadmap).
import { createPool, one } from './db.js';
import { verifyAuditChain } from './lib/audit.js';
import { hashSecret, randomToken } from './lib/crypto.js';
import { trialBalance } from './modules/ledger.js';

const [cmd, ...args] = process.argv.slice(2);
const pool = createPool();

async function main() {
  if (cmd === 'create-officer') {
    const [username, name, agency, role] = args;
    if (!username || !name || !agency || !['caseworker', 'counter', 'admin'].includes(role)) {
      throw new Error('usage: create-officer <username> "<Full Name>" <AGENCY> <caseworker|counter|admin>');
    }
    const password = randomToken(12);
    await pool.query('INSERT INTO officers (username, name, agency, role, password_hash) VALUES ($1,$2,$3,$4,$5)', [username, name, agency.toUpperCase(), role, await hashSecret(password)]);
    console.log(`Created ${username} (${agency.toUpperCase()} ${role}). One-time password: ${password}`);
  } else if (cmd === 'rotate-issuer-key') {
    const [id] = args;
    const key = randomToken(24);
    const r = await pool.query('UPDATE issuers SET api_key_hash = $2 WHERE id = $1', [id, await hashSecret(key)]);
    if (!r.rowCount) throw new Error(`Unknown issuer ${id}`);
    console.log(`New API key for ${id}: ${key}\nThe old key stopped working now.`);
  } else if (cmd === 'verify-integrity') {
    const tb = await trialBalance(pool);
    const broken = await verifyAuditChain(pool);
    const n = await one<any>(pool, 'SELECT count(*)::int AS n FROM audit_log');
    console.log(`Ledger trial balance: ${tb === 0 ? 'OK (0)' : 'OUT OF BALANCE by ' + tb}`);
    console.log(`Audit chain (${n.n} rows): ${broken === null ? 'intact' : 'BROKEN at row ' + broken}`);
    if (tb !== 0 || broken !== null) process.exitCode = 2;
  } else {
    console.log('Commands: create-officer, rotate-issuer-key, verify-integrity');
  }
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
