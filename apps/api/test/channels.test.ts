import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmClient } from '../src/modules/assistant.js';
import { balance, call, harness, login, MPHO, NALEDI, type Harness } from './helpers.js';

/** Scripted stand-in for the Claude Messages API: replays a fixed tool-use conversation. */
class FakeClaude implements LlmClient {
  calls: any[] = [];
  constructor(private script: ((req: any) => any)[]) {}
  messages = {
    create: async (req: any) => {
      this.calls.push(req);
      const step = this.script[this.calls.length - 1];
      if (!step) throw new Error('script exhausted');
      return step(req);
    },
  };
}

describe('USSD *321#', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(() => h.close());

  const ussd = (sessionId: string, phoneNumber: string, text: string) =>
    h.app.inject({ method: 'POST', url: '/v1/ussd', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ sessionId, phoneNumber, serviceCode: '*321#', text }).toString() }).then((r) => r.body);

  it('shows the main menu and balance behind the PIN', async () => {
    expect(await ussd('s1', '+26771234558', '')).toMatch(/^CON Kgotla\n1\. My ID/);
    expect(await ussd('s1', '+26771234558', '2')).toBe('CON Enter your PIN:');
    expect(await ussd('s1', '+26771234558', '2*9999')).toMatch(/^END Wrong PIN/);
    expect(await ussd('s1', '+26771234558', '2*2580')).toBe('END Your balance: P 2,050.00');
  });

  it('sends money with read-back and PIN', async () => {
    const t = await login(h.app, MPHO);
    const before = await balance(h.app, t);
    expect(await ussd('s2', '71234558', '3')).toContain('mobile number');
    expect(await ussd('s2', '71234558', '3*72345614')).toContain('amount');
    const rb = await ussd('s2', '71234558', '3*72345614*75');
    expect(rb).toContain('To: Mpho K.');
    expect(rb).toContain('Amount: P 75.00');
    expect(await ussd('s2', '71234558', '3*72345614*75*2580')).toBe('END Sent P 75.00 to Mpho Kgosi.');
    expect(await balance(h.app, t)).toBe(before + 7500);
  });

  it('gives a queue ticket to an unregistered phone', async () => {
    expect(await ussd('s3', '+26779000001', '')).toContain('1. Queue ticket');
    expect(await ussd('s3', '+26779000001', '1')).toContain('DRTS · Gaborone Main Mall');
    const end = await ussd('s3', '+26779000001', '1*2*1');
    expect(end).toMatch(/^END [AB]-\d{3}/);
  });
});

describe('Claude assistant', () => {
  it('prepares actions through tools but cannot execute them', async () => {
    const fake = new FakeClaude([
      () => ({
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 't1', name: 'get_my_account', input: {} },
        ],
      }),
      (req) => {
        const res = JSON.parse(req.messages.at(-1).content[0].content);
        const mpho = res.contacts.find((c: any) => c.name.startsWith('Mpho'));
        return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'propose_send_money', input: { to_phone: mpho.phone, amount_bwp: 200 } }] };
      },
      () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '**Send P 200.00 to Mpho K.** Tap the button and enter your PIN.' }] }),
    ]);
    const h = await harness({ llm: fake });
    try {
      const t = await login(h.app, NALEDI);
      const before = await balance(h.app, t);
      const r = await call(h.app, t, 'POST', '/v1/assistant', { messages: [{ role: 'user', content: 'Send 200 pula to Mpho' }], lang: 'en' });
      expect(r.status).toBe(200);
      expect(r.json.mode).toBe('claude');
      expect(r.json.reply).toBe('Send P 200.00 to Mpho K. Tap the button and enter your PIN.');
      expect(r.json.actions).toHaveLength(1);
      expect(r.json.actions[0].status).toBe('pending');
      expect(r.json.actions[0].label).toBe('Send P 200.00 to Mpho K.');
      // Nothing moved.
      expect(await balance(h.app, t)).toBe(before);
      // The model was given no tool that can execute or confirm.
      const tools = fake.calls[0].tools.map((x: any) => x.name);
      expect(tools.every((n: string) => /^(get_|propose_|request_human_agent$)/.test(n))).toBe(true);
      // The citizen confirms in the app.
      const done = await call(h.app, t, 'POST', `/v1/actions/${r.json.actions[0].id}/confirm`, { pin: NALEDI.pin });
      expect(done.json.status).toBe('done');
      expect(await balance(h.app, t)).toBe(before - 20000);
      const audit = await h.pool.query(`SELECT actor, data FROM audit_log WHERE action = 'action.send_money' ORDER BY id DESC LIMIT 1`);
      expect(audit.rows[0].actor).toMatch(/^assistant:/);
      expect(audit.rows[0].data.confirmedWith).toBe('pin');
    } finally {
      await h.close();
    }
  });

  it('returns tool errors to the model instead of failing', async () => {
    const fake = new FakeClaude([
      () => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'propose_send_money', input: { to_phone: '+26779999999', amount_bwp: 50 } }] }),
      (req) => {
        const tr = req.messages.at(-1).content[0];
        expect(tr.is_error).toBe(true);
        expect(tr.content).toContain('No Kgotla wallet');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'That number has no Kgotla wallet.' }] };
      },
    ]);
    const h = await harness({ llm: fake });
    try {
      const t = await login(h.app, NALEDI);
      const r = await call(h.app, t, 'POST', '/v1/assistant', { messages: [{ role: 'user', content: 'send 50 to 79999999' }] });
      expect(r.json.reply).toBe('That number has no Kgotla wallet.');
      expect(r.json.actions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('falls back to rules without an API key', async () => {
    const h = await harness();
    try {
      const t = await login(h.app, NALEDI);
      const r = await call(h.app, t, 'POST', '/v1/assistant', { messages: [{ role: 'user', content: 'I need a tax clearance' }] });
      expect(r.json.mode).toBe('rules');
      expect(r.json.actions[0].type).toBe('tax_clearance');
    } finally {
      await h.close();
    }
  });
});
