(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let session = null;
  let path = [];
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
  $('keys').innerHTML = keys.map((k) => `<button data-k="${k}">${k}</button>`).join('');
  $('keys').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) $('in').value += b.dataset.k; });
  $('clr').addEventListener('click', () => { $('in').value = $('in').value.slice(0, -1); });
  $('end').addEventListener('click', () => { session = null; path = []; $('lcd').textContent = 'Session ended. Dial *321# and press Call.'; $('in').value = '*321#'; });

  async function send(text) {
    const res = await fetch('/v1/ussd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: session, phoneNumber: $('phone').value, serviceCode: '*321#', text }) });
    const body = await res.text();
    if (!res.ok) { $('lcd').textContent = 'Network error.'; session = null; return; }
    const ended = body.startsWith('END ');
    $('lcd').textContent = body.slice(4);
    if (ended) { session = null; path = []; }
  }

  $('call').addEventListener('click', async () => {
    const v = $('in').value.trim();
    if (!session) {
      if (v !== '*321#') { $('lcd').textContent = 'Dial *321# to open Kgotla.'; return; }
      session = 'sim-' + Math.random().toString(36).slice(2);
      path = [];
      $('in').value = '';
      return send('');
    }
    if (!v) return;
    path.push(v);
    $('in').value = '';
    await send(path.join('*'));
  });
  $('in').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('call').click(); });
})();
