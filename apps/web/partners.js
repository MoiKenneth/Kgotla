/* Kgotla partner portal: organisations apply, then manage API keys, webhooks and see activity. */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $ = (id) => document.getElementById(id);
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} }, del: (k) => { try { sessionStorage.removeItem(k); } catch (e) {} } };
  const S = { token: ss.get('kgp.token'), cfg: null, cat: null, me: null, mode: 'apply', type: 'clinic', error: '', applied: null, newKey: null, secret: null, msg: '' };
  const CAP = {
    'identity.basic': 'Name and ID last 4', 'identity.kyc': 'Verified identity (eKYC)', 'documents.read': 'List Vault documents', 'documents.issue': 'Issue documents to the Vault',
    'payments.request': 'Send bills citizens pay with their PIN', 'notifications.send': 'Send messages and reminders', 'locations.manage': 'Publish bookable clinic slots',
  };
  const dt = (x) => (x ? new Date(x).toISOString().slice(0, 16).replace('T', ' ') : '');

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: Object.assign({ 'content-type': 'application/json' }, S.token ? { authorization: 'Bearer ' + S.token } : {}), body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && S.token) { S.token = null; ss.del('kgp.token'); S.me = null; render(); }
    if (!r.ok) {
      const e = j.error || { message: 'Request failed' };
      const fields = e.details && e.details.fieldErrors ? Object.entries(e.details.fieldErrors).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : '';
      throw { message: fields ? `${e.message}. ${fields}` : e.message, code: e.code };
    }
    return j;
  }

  // ------------------------------------------------------------------ signed out
  function howItWorks() {
    const t = S.cat && S.cat.types.find((x) => x.type === S.type);
    return `<div class="panel" style="display:grid;gap:14px"><h2>How connecting works</h2>
      <ol class="steps">
        <li><b>Apply here.</b> We check your licence with ${t ? esc(t.regulator.name) : 'your regulator'} and your registration with ${S.cat ? esc(S.cat.companyRegistry.name) : 'the company registry'}.</li>
        <li><b>Kgotla reviews</b> and approves only what your organisation needs.</li>
        <li><b>Create API keys</b> and set a webhook URL in this portal.</li>
        <li><b>Ask people for consent.</b> Each person approves in the Kgotla app with their PIN, and can withdraw it at any time.</li>
        <li><b>Go live:</b> issue documents, send bills people pay with their PIN, publish clinic slots, verify identity.</li>
      </ol>
      ${t ? `<div class="typeinfo"><b style="color:var(--ink)">A ${esc(t.label.toLowerCase())} can</b><div class="caps">${t.capabilities.map((c) => `<span class="chip">${esc(CAP[c] || c)}</span>`).join('')}</div>
        <span>Documents you can issue: ${t.documentTypes.map((d) => `<span class="mono">${esc(d)}</span>`).join(', ')}</span></div>` : ''}
      ${S.cfg && S.cfg.demoMode ? `<div class="demo">Demo cell. Sign in as the demo clinic <span class="mono">clinic@demo.kgotla</span>, bank <span class="mono">bank@demo.kgotla</span> or doctor (waiting for review) <span class="mono">doctor@demo.kgotla</span>${S.cfg.pack && S.cfg.pack.demo && S.cfg.pack.demo.officerPassword ? `, password <b>${esc(S.cfg.pack.demo.officerPassword)}</b>` : ' (password in this cell\'s Key Vault)'}.</div>` : ''}
    </div>`;
  }

  function applyForm() {
    if (!S.cat) return '<div class="panel">Loading…</div>';
    const t = S.cat.types.find((x) => x.type === S.type);
    if (S.applied) {
      const c = S.applied.licenceCheck;
      return `<div class="panel" style="display:grid;gap:12px"><h2>Application received</h2>
        <p>Reference <span class="mono">${esc(S.applied.code)}</span>. Kgotla will review it. Sign in with your email and password to follow its status.</p>
        <p>Licence check: ${c.status === 'verified' ? '<span class="chip good">FOUND</span>' : '<span class="chip crit">NOT FOUND</span>'} ${esc(c.detail)}</p>
        <button class="btn" data-mode="login">Sign in</button></div>`;
    }
    return `<form class="panel form" id="applyForm"><h2>Apply to connect</h2>
      <div class="field"><label for="type">Organisation type</label><select id="type">${S.cat.types.map((x) => `<option value="${x.type}" ${x.type === S.type ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></div>
      <div class="two"><div class="field"><label for="legalName">Legal name</label><input id="legalName" required minlength="3" maxlength="120" autocomplete="organization"></div>
      <div class="field"><label for="tradingName">Name people know you by</label><input id="tradingName" maxlength="80"></div></div>
      <div class="two"><div class="field"><label for="registrationNo">${esc(S.cat.companyRegistry.code)} registration number</label><input id="registrationNo" required minlength="3" maxlength="40" class="mono"></div>
      <div class="field"><label for="licenceNo">${esc(t.regulator.code)} licence or practice number</label><input id="licenceNo" required minlength="3" maxlength="40" class="mono"></div></div>
      <div class="two"><div class="field"><label for="contactName">Contact person</label><input id="contactName" required maxlength="80" autocomplete="name"></div>
      <div class="field"><label for="contactPhone">Contact phone</label><input id="contactPhone" required inputmode="tel" autocomplete="tel" placeholder="${esc(S.cfg && S.cfg.pack ? S.cfg.pack.phone.example : '')}"></div></div>
      <div class="two"><div class="field"><label for="contactEmail">Email (your portal sign-in)</label><input id="contactEmail" type="email" required autocomplete="email"></div>
      <div class="field"><label for="password">Portal password (10+ characters)</label><input id="password" type="password" required minlength="10" autocomplete="new-password"></div></div>
      <div class="field"><label for="webhookUrl">Webhook URL (optional, can be set later)</label><input id="webhookUrl" type="url" placeholder="https://api.example.com/kgotla/events" class="mono"></div>
      ${S.error ? `<p class="err">${esc(S.error)}</p>` : ''}
      <div class="row"><button class="btn sky">Submit application</button><span class="hint">Already applied? <a href="#" data-mode="login">Sign in</a></span></div></form>`;
  }

  function loginForm() {
    return `<form class="panel form" id="loginForm" style="max-width:440px"><h2>Sign in</h2>
      <div class="field"><label for="email">Email</label><input id="email" type="email" required autocomplete="username"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" required autocomplete="current-password"></div>
      ${S.error ? `<p class="err">${esc(S.error)}</p>` : ''}
      <div class="row"><button class="btn">Sign in</button><span class="hint">New partner? <a href="#" data-mode="apply">Apply</a></span></div></form>`;
  }

  // ------------------------------------------------------------------ signed in
  function dashboard() {
    const v = S.me; const p = v.partner;
    const live = p.status === 'approved';
    const banner = p.status === 'applied'
      ? `<div class="banner wait"><b>Waiting for review</b><span>Kgotla is checking your application. Licence check: ${p.licenceCheck.status === 'verified' ? 'found' : 'not found'} in ${esc(p.licenceCheck.register || p.regulator)}.</span></div>`
      : live ? `<div class="banner live"><b>Live</b><span>${esc(p.typeLabel)} · ${esc(p.regulator)} · licence <span class="mono">${esc(p.licenceNo)}</span></span><div class="caps">${p.capabilities.map((c) => `<span class="chip good">${esc(CAP[c] || c)}</span>`).join('')}</div></div>`
      : `<div class="banner stop"><b>${p.status === 'suspended' ? 'Suspended' : 'Not approved'}</b><span>${esc(p.reviewNote || 'Contact Kgotla partner support.')}</span></div>`;

    const keys = `<div class="panel" style="display:grid;gap:10px"><h2>API keys</h2>
      <p class="hint">Your systems exchange a key for a one-hour access token (OAuth 2.0 client credentials). The secret is shown once.</p>
      ${S.newKey ? `<div class="secret"><span>Copy the secret now. It is not shown again.</span><span>Client ID <code>${esc(S.newKey.clientId)}</code></span><span>Client secret <code>${esc(S.newKey.clientSecret)}</code></span></div>` : ''}
      ${v.credentials.length ? `<div class="tbl"><table><thead><tr><th>Client ID</th><th>Label</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${v.credentials.map((c) => `<tr><td class="mono">${esc(c.clientId)}</td><td>${esc(c.label)}</td><td class="mono">${dt(c.createdAt)}</td><td class="mono">${dt(c.lastUsedAt) || '—'}</td><td>${c.revoked ? '<span class="chip crit">REVOKED</span>' : `<button class="btn crit" data-revoke="${c.id}">Revoke</button>`}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No keys yet.</p>'}
      <div class="row"><input id="keyLabel" placeholder="Label, e.g. Patient system" maxlength="60"><button class="btn sky" id="newKey" ${live ? '' : 'disabled'}>Create API key</button></div></div>`;

    const hook = `<div class="panel" style="display:grid;gap:10px"><h2>Webhook</h2>
      <p class="hint">We POST signed events here: consent granted or withdrawn, bills paid, clinic bookings. Check the <span class="mono">Kgotla-Signature</span> header with your signing secret.</p>
      <div class="row"><input id="hookUrl" class="mono" style="flex:1;min-width:220px" value="${esc(v.webhook.url || '')}" placeholder="https://api.example.com/kgotla/events"><button class="btn" id="saveHook">Save</button><button class="btn ghost" id="testHook" ${live && v.webhook.url ? '' : 'disabled'}>Send test event</button></div>
      <div class="row"><button class="btn ghost" id="showSecret">Show signing secret</button><button class="btn ghost" id="rotateSecret">Rotate secret</button>${S.secret ? `<code class="mono" style="word-break:break-all">${esc(S.secret)}</code>` : ''}</div>
      ${v.webhook.deliveries.length ? `<div class="tbl"><table><thead><tr><th>#</th><th>Event</th><th>Status</th><th>Tries</th><th>Last result</th><th>Created</th></tr></thead><tbody>${v.webhook.deliveries.map((d) => `<tr><td class="mono">${d.id}</td><td class="mono">${esc(d.event)}</td><td>${d.status === 'delivered' ? '<span class="chip good">DELIVERED</span>' : d.status === 'failed' ? '<span class="chip crit">FAILED</span>' : '<span class="chip warn">RETRYING</span>'}</td><td>${d.attempts}</td><td class="mono">${esc(d.last_error || d.last_status || '')}</td><td class="mono">${dt(d.created_at)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No events sent yet.</p>'}
      ${v.webhook.demoInbox.length ? `<p class="hint">Demo receiver got: ${v.webhook.demoInbox.map((x) => `<span class="mono">${esc(x.event)}</span> ${x.signature_ok ? '<span class="chip good">SIGNATURE OK</span>' : '<span class="chip crit">BAD SIGNATURE</span>'}`).join(' · ')}</p>` : ''}</div>`;

    const activity = `<div class="stats">${[['People connected', v.consents.granted], ['Consent requests waiting', v.consents.waiting], ['Declined or withdrawn', v.consents.declined_or_revoked], ['Bills paid', v.payments.paid], ['Collected', v.payments.paidTotalText], ['Bills waiting', v.payments.pending]].map(([l, x]) => `<div class="stat"><b>${esc(x)}</b><span>${l}</span></div>`).join('')}</div>`;

    const base = v.apiBase;
    const sample = v.credentials.find((c) => !c.revoked);
    const cid = S.newKey ? S.newKey.clientId : sample ? sample.clientId : 'YOUR_CLIENT_ID';
    const idEx = S.cfg && S.cfg.pack ? S.cfg.pack.nationalId.example : '';
    const quick = `<div class="panel" style="display:grid;gap:10px"><h2>Quick start</h2>
      <p class="hint">1. Get an access token.</p>
      <pre>curl -s ${esc(base)}/oauth/token \\
  -d grant_type=client_credentials -d client_id=${esc(cid)} -d client_secret=YOUR_SECRET</pre>
      <p class="hint">2. Ask a person for consent. They approve in the Kgotla app with their PIN.</p>
      <pre>curl -s ${esc(base)}/partner/consents -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  -d '{"nationalId":"${esc(idEx)}","scopes":["identity.basic","payments.request"],"purpose":"Your bills from us"}'</pre>
      <p class="hint">3. When the <span class="mono">consent.granted</span> webhook arrives (or <span class="mono">GET /partner/consents/{id}</span> shows granted), use the <span class="mono">subject</span> id it gives you.</p>
      <pre>curl -s ${esc(base)}/partner/citizens/$SUBJECT/payment-requests -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \\
  -d '{"amount":"150.00","reference":"INV-1001","description":"Consultation"}'</pre>
      <p class="hint">Full reference: docs/PARTNERS.md in the Kgotla repository, and <span class="mono">GET ${esc(base)}/partners/catalogue</span>.</p></div>`;

    const locs = p.capabilities.includes('locations.manage') ? `<div class="panel" style="display:grid;gap:10px"><h2>Bookable locations</h2>
      ${v.locations.length ? `<div class="tbl"><table><thead><tr><th>Id</th><th>Name</th><th>Per slot</th><th>Slots</th></tr></thead><tbody>${v.locations.map((l) => `<tr><td class="mono">${esc(l.id)}</td><td>${esc(l.name)}</td><td>${l.capacity}</td><td class="mono">${esc(l.slot_times.join(' '))}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">None yet. Publish one with <span class="mono">PUT /v1/partner/locations</span>; it appears in the Kgotla app under Book a clinic.</p>'}</div>` : '';

    return `${banner}${S.msg ? `<p class="hint">${esc(S.msg)}</p>` : ''}${live ? activity : ''}<div class="grid2"><div style="display:grid;gap:18px">${keys}${hook}${locs}</div><div style="display:grid;gap:18px">${quick}</div></div>`;
  }

  function render() {
    $('logout').hidden = !S.token;
    if (S.token && S.me) {
      $('who').textContent = `${S.me.partner.tradingName} · ${S.me.partner.contactEmail}`;
      $('main').innerHTML = dashboard();
      return;
    }
    $('who').textContent = '';
    $('main').innerHTML = `<div class="tabs"><button data-mode="apply" aria-pressed="${S.mode === 'apply'}">Apply to connect</button><button data-mode="login" aria-pressed="${S.mode === 'login'}">Sign in</button></div>
      <div class="grid2">${S.mode === 'apply' ? applyForm() : loginForm()}${howItWorks()}</div>`;
  }

  async function load() { S.me = await api('GET', '/v1/partner-portal/me'); render(); }

  document.addEventListener('click', async (e) => {
    const el = e.target.closest('button, a'); if (!el) return;
    try {
      if (el.dataset.mode) { e.preventDefault(); S.mode = el.dataset.mode; S.error = ''; S.applied = null; render(); }
      else if (el.id === 'logout') { try { await api('POST', '/v1/partner-portal/logout'); } catch (x) {} S.token = null; S.me = null; ss.del('kgp.token'); S.mode = 'login'; render(); }
      else if (el.id === 'newKey') { el.disabled = true; S.newKey = await api('POST', '/v1/partner-portal/credentials', { label: $('keyLabel').value.trim() || 'API key' }); await load(); }
      else if (el.dataset.revoke) { el.disabled = true; await api('DELETE', `/v1/partner-portal/credentials/${el.dataset.revoke}`); S.newKey = null; await load(); }
      else if (el.id === 'saveHook') { await api('PUT', '/v1/partner-portal/webhook', { url: $('hookUrl').value.trim() || null }); S.msg = 'Webhook saved.'; await load(); }
      else if (el.id === 'testHook') { await api('POST', '/v1/partner-portal/webhook/test', {}); S.msg = 'Test event queued. It appears below within a few seconds.'; await load(); setTimeout(() => load().catch(() => {}), 4000); }
      else if (el.id === 'showSecret' || el.id === 'rotateSecret') { S.secret = (await api('POST', '/v1/partner-portal/webhook/secret', { rotate: el.id === 'rotateSecret' })).secret; S.msg = el.id === 'rotateSecret' ? 'New secret in use. Update your server.' : ''; render(); }
    } catch (x) { S.msg = x.message; render(); }
  });
  document.addEventListener('change', (e) => { if (e.target.id === 'type') { S.type = e.target.value; render(); } });
  document.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => ($(id) ? $(id).value.trim() : '');
    if (e.target.id === 'applyForm') {
      const b = e.target.querySelector('button'); b.disabled = true;
      try {
        S.applied = await api('POST', '/v1/partners/apply', {
          type: S.type, legalName: v('legalName'), tradingName: v('tradingName') || undefined, registrationNo: v('registrationNo'), licenceNo: v('licenceNo'),
          contactName: v('contactName'), contactEmail: v('contactEmail'), contactPhone: v('contactPhone'), password: $('password').value, webhookUrl: v('webhookUrl') || undefined,
        });
        S.error = '';
      } catch (x) { S.error = x.message; }
      render();
    }
    if (e.target.id === 'loginForm') {
      try {
        const r = await api('POST', '/v1/partner-portal/login', { email: v('email'), password: $('pw').value });
        S.token = r.token; ss.set('kgp.token', r.token); S.error = ''; await load();
      } catch (x) { S.error = x.message; render(); }
    }
  });
  setInterval(() => { if (S.token && S.me && document.visibilityState === 'visible' && !document.activeElement.matches('input')) load().catch(() => {}); }, 15000);

  (async () => {
    try { S.cfg = await (await fetch('/v1/config')).json(); $('title').textContent = `Kgotla Partner Portal · ${S.cfg.pack.name}`; document.title = `Kgotla Partner Portal · ${S.cfg.pack.name}`; } catch (e) {}
    try { S.cat = await (await fetch('/v1/partners/catalogue')).json(); } catch (e) {}
    if (S.token) { try { await load(); return; } catch (e) { S.token = null; ss.del('kgp.token'); } }
    render();
  })();
})();
