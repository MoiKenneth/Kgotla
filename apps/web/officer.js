/* Kgotla officer console: case workers move applications, counter staff call tickets, admins check integrity. */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $ = (id) => document.getElementById(id);
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} }, del: (k) => { try { sessionStorage.removeItem(k); } catch (e) {} } };
  const S = { token: ss.get('kgo.token'), me: null, tab: null, status: 'open', office: null, counter: 1, cfg: null, error: '' };
  const fdt = (x) => { const d = new Date(new Date(x).getTime() + 2 * 3600e3); return d.toISOString().slice(0, 16).replace('T', ' '); };

  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: Object.assign({ 'content-type': 'application/json' }, S.token ? { authorization: 'Bearer ' + S.token } : {}), body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && S.token) { S.token = null; ss.del('kgo.token'); render(); }
    if (!r.ok) throw j.error || { message: 'Request failed' };
    return j;
  }

  function render() {
    const main = $('main');
    $('logout').hidden = !S.token;
    if (!S.token || !S.me) {
      $('who').textContent = '';
      main.innerHTML = `<form class="login panel" id="loginForm"><h2>Sign in</h2>
        <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" required></div>
        <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
        ${S.error ? `<p class="err">${esc(S.error)}</p>` : ''}<button class="btn">Sign in</button>
        ${S.cfg && S.cfg.demoMode ? `<div class="demo">Demo accounts, password <b>kgotla-demo</b>: <span class="mono">drts.case</span>, <span class="mono">cnr.case</span>, <span class="mono">burs.case</span> (case workers), <span class="mono">drts.counter</span> (counter), <span class="mono">admin</span>.</div>` : ''}</form>`;
      return;
    }
    $('who').textContent = `${S.me.name} · ${S.me.agency} · ${S.me.role}`;
    const tabs = S.me.role === 'admin' ? ['overview', 'applications', 'queue'] : S.me.role === 'caseworker' ? ['applications'] : ['queue'];
    if (!tabs.includes(S.tab)) S.tab = tabs[0];
    main.innerHTML = `<div class="tabs">${tabs.map((x) => `<button data-tab="${x}" aria-pressed="${S.tab === x}">${{ overview: 'Overview', applications: 'Applications', queue: 'Smart queue' }[x]}</button>`).join('')}</div><div id="pane"><div class="panel">Loading…</div></div>`;
    ({ overview, applications, queue })[S.tab]().catch((e) => { $('pane').innerHTML = `<div class="panel"><p class="err">${esc(e.message)}</p></div>`; });
  }

  async function overview() {
    const o = await api('GET', '/v1/officer/overview');
    $('pane').innerHTML = `<div class="stats">
      ${[['Citizens', o.citizens], ['Open applications', o.open_applications], ['Completed', o.completed_applications], ['Confirmed actions', o.actions_done], ['Prepared by assistant', o.assistant_actions], ['Queue tickets today', o.tickets_today], ['SMS waiting', o.outbox_pending]].map(([l, v]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join('')}
      <div class="stat"><b>${o.ledgerBalanced ? '<span class="chip good">BALANCED</span>' : '<span class="chip crit">OUT OF BALANCE</span>'}</b><span>Ledger trial balance</span></div>
      <div class="stat"><b>${o.auditChainIntact ? '<span class="chip good">INTACT</span>' : `<span class="chip crit">BROKEN AT ${esc(o.auditBrokenAt)}</span>`}</b><span>Audit hash chain</span></div></div>`;
  }

  async function applications() {
    const rows = await api('GET', `/v1/officer/applications?status=${S.status}`);
    $('pane').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Applications${S.me.role === 'admin' ? '' : ' · ' + esc(S.me.agency)}</h2>
      <div class="tabs">${['open', 'completed', 'rejected'].map((s) => `<button data-status="${s}" aria-pressed="${S.status === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div></div>
      ${rows.length ? `<div class="tbl"><table><thead><tr><th>Reference</th><th>Citizen</th><th>Service</th><th>Step</th><th>Submitted</th><th></th></tr></thead><tbody>
      ${rows.map((a) => {
        const next = a.steps[a.step + 1];
        return `<tr><td class="mono">${esc(a.ref)}</td><td>${esc(a.citizen.name)}<br><span class="hint mono">Omang ***${esc(a.citizen.omangLast4)}</span></td><td>${esc(a.title)}${a.data && a.data.licence_class ? `<br><span class="hint">Class ${esc(a.data.licence_class)}</span>` : ''}</td>
          <td>${a.status === 'open' ? `<span class="chip">${esc(a.steps[a.step].label)}</span><br><span class="hint">${a.step + 1} of ${a.steps.length}</span>` : a.status === 'completed' ? '<span class="chip good">Completed</span>' : '<span class="chip crit">Rejected</span>'}</td>
          <td class="mono">${esc(fdt(a.createdAt))}</td>
          <td>${a.status === 'open' && next ? `<div class="row"><button class="btn sky" data-adv="${a.id}">${esc(next.label)}</button><button class="btn crit" data-rej="${a.id}">Reject</button></div>` : ''}</td></tr>`;
      }).join('')}</tbody></table></div>` : '<p class="hint">Nothing here.</p>'}</div>`;
  }

  async function queue() {
    const offices = await api('GET', '/v1/officer/offices');
    if (!S.office || !offices.some((o) => o.id === S.office)) S.office = (offices.find((o) => o.id.startsWith((S.me.agency || '').toLowerCase())) || offices[0]).id;
    const office = offices.find((o) => o.id === S.office);
    const board = await api('GET', `/v1/officer/queue/${S.office}`);
    $('pane').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Smart queue</h2>
      <div class="row"><select id="office" aria-label="Office">${offices.map((o) => `<option value="${o.id}" ${o.id === S.office ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select>
      <select id="counter" aria-label="Counter">${Array.from({ length: office.counter_count }, (_, i) => `<option value="${i + 1}" ${S.counter === i + 1 ? 'selected' : ''}>Counter ${i + 1}</option>`).join('')}</select>
      <button class="btn sky" id="callNext">Call next</button></div></div>
      <p class="hint" id="callMsg">Calling next marks this counter's current ticket as served, texts the next person, and warns whoever is now 3 places away.</p>
      <div class="board" style="margin-top:12px">${board.length ? board.map((t) => `<div class="tk ${t.status}"><b>${esc(t.label)}</b><small>${esc(t.service)}</small><small>${t.status === 'called' ? `Counter ${esc(t.counter)}` : 'Waiting since ' + esc(fdt(t.created_at).slice(11))}</small></div>`).join('') : '<p class="hint">No one is waiting.</p>'}</div></div>`;
  }

  let rejecting = null;
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('button'); if (!el) return;
    try {
      if (el.dataset.tab) { S.tab = el.dataset.tab; render(); }
      else if (el.dataset.status) { S.status = el.dataset.status; render(); }
      else if (el.dataset.adv) { el.disabled = true; await api('POST', `/v1/officer/applications/${el.dataset.adv}/advance`, {}); render(); }
      else if (el.dataset.rej) { rejecting = el.dataset.rej; $('reason').value = ''; $('rejectDlg').showModal(); }
      else if (el.id === 'callNext') {
        el.disabled = true;
        const r = await api('POST', `/v1/officer/queue/${S.office}/call-next`, { counter: S.counter });
        await queue();
        $('callMsg').textContent = r.empty ? 'No one is waiting.' : `Called ${r.label} to counter ${r.counter}. They were notified.`;
      } else if (el.id === 'logout') { try { await api('POST', '/v1/auth/logout'); } catch (x) {} S.token = null; S.me = null; ss.del('kgo.token'); render(); }
    } catch (x) { alertInline(x.message); el.disabled = false; }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'office') { S.office = e.target.value; render(); }
    if (e.target.id === 'counter') S.counter = Number(e.target.value);
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'loginForm') {
      e.preventDefault();
      try {
        const r = await api('POST', '/v1/officer/login', { username: $('u').value.trim(), password: $('p').value });
        S.token = r.token; ss.set('kgo.token', r.token); S.me = r.officer; S.error = ''; render();
      } catch (x) { S.error = x.message; render(); }
    }
  });
  $('rejectDlg').addEventListener('close', async () => {
    if ($('rejectDlg').returnValue !== 'ok' || !rejecting) return;
    try { await api('POST', `/v1/officer/applications/${rejecting}/reject`, { reason: $('reason').value.trim() }); } catch (x) { alertInline(x.message); }
    rejecting = null; render();
  });
  function alertInline(msg) { const p = $('pane') || $('main'); const n = document.createElement('p'); n.className = 'err'; n.textContent = msg; p.prepend(n); setTimeout(() => n.remove(), 5000); }

  setInterval(() => { if (S.token && S.me && S.tab === 'queue' && !document.querySelector('select:focus')) queue().catch(() => {}); }, 8000);

  (async () => {
    try { S.cfg = await api('GET', '/v1/config'); } catch (e) {}
    if (S.token) { try { S.me = await api('GET', '/v1/officer/me'); } catch (e) { S.token = null; ss.del('kgo.token'); } }
    render();
  })();
})();
