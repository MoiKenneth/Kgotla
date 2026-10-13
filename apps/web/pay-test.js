(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const id = new URLSearchParams(location.search).get('payment') || '';
  let info = null;
  async function load() {
    const r = await fetch(`/v1/payments/test/${encodeURIComponent(id)}`);
    const j = await r.json();
    if (!r.ok) { $('box').innerHTML = `<p class="err">${esc((j.error && j.error.message) || 'Payment not found')}</p>`; return; }
    info = j;
    $('box').innerHTML = j.status !== 'pending'
      ? `<p>This payment is already ${esc(j.status)}.</p><a class="btn" href="${esc(j.returnUrl)}">Back to Kgotla</a>`
      : `<h2>Pay ${esc(j.amountText)}</h2><p class="hint">${esc(j.name)}, ${j.purpose === 'action' ? 'this pays for what you were booking' : 'this tops up your Kgotla wallet'}.</p>
         <div class="row"><button class="btn sky" id="approve">Approve test payment</button><button class="btn ghost" id="cancel">Cancel</button></div>`;
  }
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || !info) return;
    const approve = b.id === 'approve';
    if (!approve && b.id !== 'cancel') return;
    b.disabled = true;
    await fetch(`/v1/payments/test/${encodeURIComponent(id)}/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve }) });
    location.assign(info.returnUrl + (approve ? '' : '&cancelled=1'));
  });
  load().catch(() => { $('box').textContent = 'Could not load the payment.'; });
})();
