/* Kgotla officer console: case workers move applications, counter staff call tickets, admins check integrity. */
(function () {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const $ = (id) => document.getElementById(id);
  const ss = { get: (k) => { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { sessionStorage.setItem(k, v); } catch (e) {} }, del: (k) => { try { sessionStorage.removeItem(k); } catch (e) {} } };
  const S = { token: ss.get('kgo.token'), me: null, tab: null, status: 'open', pstatus: 'applied', office: null, counter: 1, cfg: null, error: '' };
  const idShort = () => (S.cfg && S.cfg.pack ? S.cfg.pack.nationalId.short : 'ID');
  const fdt = (x) => { const off = S.cfg && S.cfg.pack ? S.cfg.pack.utcOffsetMinutes : 120; const d = new Date(new Date(x).getTime() + off * 60e3); return d.toISOString().slice(0, 16).replace('T', ' '); };

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
        ${S.cfg && S.cfg.demoMode && S.cfg.pack && S.cfg.pack.demo ? `<div class="demo">Demo accounts${S.cfg.pack.demo.officerPassword ? `, password <b>${esc(S.cfg.pack.demo.officerPassword)}</b>` : ' (password is in this cell\'s Key Vault)'}: ${S.cfg.pack.demo.officers.map((o) => `<span class="mono">${esc(o.username)}</span> (${esc(o.agency)} ${esc(o.role)})`).join(', ')}.</div>` : ''}</form>`;
      return;
    }
    $('who').textContent = `${S.me.name} · ${S.me.agency} · ${S.me.role}`;
    const parks = S.cfg && S.cfg.tourism ? S.cfg.tourism.parksAgency.code : null;
    const tabs = S.me.role === 'admin' ? ['overview', 'partners', 'directory', 'permits', 'staff', 'applications', 'queue'] : S.me.agency === parks ? ['permits'] : S.me.role === 'caseworker' ? ['applications'] : ['queue'];
    if (!tabs.includes(S.tab)) S.tab = tabs[0];
    main.innerHTML = `<div class="tabs">${tabs.map((x) => `<button data-tab="${x}" aria-pressed="${S.tab === x}">${{ overview: 'Overview', partners: 'Partners', directory: 'Directory', permits: 'Parks', staff: 'Staff', applications: 'Applications', queue: 'Smart queue' }[x]}</button>`).join('')}</div><div id="pane"><div class="panel">Loading…</div></div>`;
    ({ overview, partners, directory, permits, staff, applications, queue })[S.tab]().catch((e) => { $('pane').innerHTML = `<div class="panel"><p class="err">${esc(e.message)}</p></div>`; });
  }

  async function overview() {
    const o = await api('GET', '/v1/officer/overview');
    $('pane').innerHTML = `<div class="stats">
      ${[['Citizens', o.citizens], ['Open applications', o.open_applications], ['Completed', o.completed_applications], ['Confirmed actions', o.actions_done], ['Prepared by assistant', o.assistant_actions], ['Queue tickets today', o.tickets_today], ['SMS waiting', o.outbox_pending], ['Partner applications waiting', o.partners_waiting], ['Partners live', o.partners_live], ['Failed webhooks', o.webhooks_failed], ['Tourism bookings', o.tourism_bookings], ['Directory entries', o.directory_entries]].map(([l, v]) => `<div class="stat"><b>${esc(v)}</b><span>${l}</span></div>`).join('')}
      <div class="stat"><b>${o.ledgerBalanced ? '<span class="chip good">BALANCED</span>' : '<span class="chip crit">OUT OF BALANCE</span>'}</b><span>Ledger trial balance</span></div>
      <div class="stat"><b>${o.auditChainIntact ? '<span class="chip good">INTACT</span>' : `<span class="chip crit">BROKEN AT ${esc(o.auditBrokenAt)}</span>`}</b><span>Audit hash chain</span></div></div>`;
  }

  const CAP_LABEL = {
    'identity.basic': 'Name and ID last 4', 'identity.kyc': 'Verified identity (eKYC)', 'documents.read': 'List Vault documents', 'documents.issue': 'Issue documents to the Vault',
    'payments.request': 'Send bills', 'notifications.send': 'Send messages', 'locations.manage': 'Publish bookable locations', 'listings.manage': 'Publish rooms, safaris and tours',
  };
  async function partners() {
    const r = await api('GET', `/v1/officer/partners?status=${S.pstatus}`);
    const chk = (c) => c.status === 'verified' ? '<span class="chip good">LICENCE VERIFIED</span>' : c.status === 'not_found' ? '<span class="chip crit">LICENCE NOT FOUND</span>' : '<span class="chip warn">NOT CHECKED</span>';
    $('pane').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Partners</h2>
      <div class="tabs">${['applied', 'approved', 'suspended', 'rejected'].map((s) => `<button data-pstatus="${s}" aria-pressed="${S.pstatus === s}">${{ applied: 'Waiting for review', approved: 'Live', suspended: 'Suspended', rejected: 'Rejected' }[s]}</button>`).join('')}</div></div>
      <p class="hint" style="margin-bottom:12px">Clinics, doctors, banks and other organisations apply at <span class="mono">/partners.html</span>. Check the licence result, confirm the company registration, then approve with only the capabilities they need.</p>
      ${r.partners.length ? `<div style="display:grid;gap:12px">${r.partners.map((p) => {
        const allowed = r.types[p.type].capabilities;
        return `<div class="panel" style="padding:14px;display:grid;gap:8px">
          <div class="row" style="justify-content:space-between"><div><b style="font-size:16px">${esc(p.tradingName)}</b> <span class="chip">${esc(p.typeLabel)}</span></div>${chk(p.licenceCheck || {})}</div>
          <div class="tbl"><table><tbody>
            <tr><th>Legal name</th><td>${esc(p.legalName)}</td><th>Registration</th><td class="mono">${esc(p.registrationNo)}</td></tr>
            <tr><th>Regulator</th><td>${esc(p.regulator)}</td><th>Licence</th><td class="mono">${esc(p.licenceNo || '')}</td></tr>
            <tr><th>Register says</th><td colspan="3">${esc((p.licenceCheck && p.licenceCheck.detail) || '')} <span class="hint">${esc((p.licenceCheck && p.licenceCheck.register) || '')}</span></td></tr>
            <tr><th>Contact</th><td>${esc(p.contactName)}<br><span class="mono">${esc(p.contactEmail)} · ${esc(p.contactPhone)}</span></td><th>Applied</th><td class="mono">${esc(fdt(p.createdAt))}</td></tr>
            ${p.reviewNote ? `<tr><th>Review note</th><td colspan="3">${esc(p.reviewNote)}</td></tr>` : ''}
          </tbody></table></div>
          ${p.status === 'applied' ? `<fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px"><legend class="hint">Capabilities to grant</legend><div class="row">${allowed.map((c) => `<label class="row" style="gap:6px;font-size:13.5px"><input type="checkbox" data-cap="${p.id}" value="${c}" checked> ${esc(CAP_LABEL[c] || c)}</label>`).join('')}</div></fieldset>
            <div class="row"><button class="btn sky" data-approve="${p.id}">Approve</button><button class="btn crit" data-pnote="${p.id}" data-pact="reject">Reject</button></div>`
          : p.status === 'approved' ? `<div class="row"><span class="hint">Can: ${p.capabilities.map((c) => esc(CAP_LABEL[c] || c)).join(' · ')}</span><button class="btn crit" data-pnote="${p.id}" data-pact="suspend">Suspend</button></div>`
          : p.status === 'suspended' ? `<div class="row"><button class="btn sky" data-reinstate="${p.id}">Reinstate</button></div>` : ''}
        </div>`;
      }).join('')}</div>` : '<p class="hint">Nothing here.</p>'}</div>`;
  }

  const SECTORS = ['government', 'tax', 'banking', 'health', 'insurance', 'utilities', 'telecoms', 'education', 'tourism', 'transport', 'other'];
  async function directory() {
    const rows = await api('GET', '/v1/directory');
    const st = (s) => s === 'connected' ? '<span class="chip good">CONNECTED</span>' : s === 'connecting' ? '<span class="chip warn">CONNECTING</span>' : '<span class="chip">LINK ONLY</span>';
    $('pane').innerHTML = `<div class="panel"><h2>Services directory</h2>
      <p class="hint" style="margin-bottom:12px">Official portals citizens can reach from Kgotla. "Link only" opens the institution's website; move an entry to "Connecting" while a partnership is agreed and "Connected" once it works through the partner hub (link it to the partner code).</p>
      <div class="tbl"><table><thead><tr><th>Name</th><th>Sector</th><th>Status</th><th>Partner</th><th>Website</th><th></th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td><b>${esc(e.name)}</b><br><span class="hint">${esc(e.description)}</span></td><td>${esc(e.sector)}</td><td>${st(e.status)}<br><select data-dirstatus="${e.id}" aria-label="Status">${['linked', 'connecting', 'connected'].map((x) => `<option ${x === e.status ? 'selected' : ''}>${x}</option>`).join('')}</select></td>
        <td class="mono">${esc(e.partner ? e.partner.code : '')}</td><td><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer" class="mono" style="word-break:break-all">${esc(e.url)}</a></td><td><button class="btn crit" data-dirdel="${e.id}">Remove</button></td></tr>`).join('')}
      </tbody></table></div></div>
      <form class="panel" id="dirForm" style="display:grid;gap:10px"><h2>Add an organisation</h2>
        <div class="row"><input id="dName" placeholder="Name, e.g. Botswana Housing Corporation" required maxlength="80" style="flex:1;min-width:220px">
        <select id="dSector">${SECTORS.map((x) => `<option>${x}</option>`).join('')}</select>
        <select id="dStatus"><option>linked</option><option>connecting</option><option>connected</option></select></div>
        <div class="row"><input id="dUrl" type="url" placeholder="https://… official website" required style="flex:1;min-width:260px" class="mono"><input id="dPartner" placeholder="Partner code (optional)" class="mono"></div>
        <input id="dDesc" placeholder="What citizens can do there" maxlength="300">
        <div class="row"><button class="btn sky">Add</button><span class="hint" id="dirMsg"></span></div></form>`;
    S.dirRows = rows;
  }

  async function permits() {
    S.pdate = S.pdate || new Date(Date.now() + ((S.cfg && S.cfg.pack ? S.cfg.pack.utcOffsetMinutes : 120) * 6e4)).toISOString().slice(0, 10);
    const [r, parks] = await Promise.all([api('GET', `/v1/officer/park-permits?date=${S.pdate}`), api('GET', '/v1/officer/parks')]);
    $('pane').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Park permits · ${esc(r.agency.name)}</h2>
      <input type="date" id="pdate" value="${esc(r.date)}" aria-label="Date"></div>
      <p class="hint" style="margin-bottom:10px">Check the visitor's ID card against the name and last 4 characters, then check them in. The permit is also in the visitor's Vault, and they can show it with a share link.</p>
      ${r.permits.length ? `<div class="tbl"><table><thead><tr><th>Permit</th><th>Park</th><th>Holder</th><th>People</th><th>Rate</th><th>Dates</th><th></th></tr></thead><tbody>${r.permits.map((x) => `<tr><td class="mono">${esc(x.ref)}</td><td>${esc(x.park)}</td><td>${esc(x.holder)}<br><span class="hint mono">${esc(idShort())} ***${esc(x.idLast4)}</span></td><td>${x.people}</td><td>${esc(x.rate)}</td><td>${esc(x.when)}</td>
        <td>${x.status === 'confirmed' ? `<button class="btn sky" data-checkin="${x.id}">Check in</button>` : '<span class="chip good">CHECKED IN</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="hint">No permits for this day.</p>'}</div>
      <div class="panel"><h2>Park fees and booking</h2>
      <p class="hint" style="margin-bottom:10px">Enter the official entry fees per person per day, then open the park for booking in Kgotla. In a live cell every park starts closed until its fees are confirmed here.</p>
      <div class="tbl"><table><thead><tr><th>Park</th>${(parks[0] ? parks[0].rates : []).map((r) => `<th>${esc(r.label)}</th>`).join('')}<th>Permits per day</th><th>Open</th><th></th></tr></thead><tbody>
      ${parks.map((p) => `<tr data-park="${esc(p.id)}"><td>${esc(p.name)}<br><span class="hint">${esc(p.region)}</span></td>${p.rates.map((r) => `<td><input class="mono" style="width:90px" data-rate="${esc(r.key)}" value="${(r.price / 100).toFixed(2)}" inputmode="decimal" aria-label="${esc(r.label)}"></td>`).join('')}
        <td><input class="mono" style="width:80px" data-cap value="${p.capacity}" inputmode="numeric" aria-label="Permits per day"></td><td><input type="checkbox" data-active ${p.active ? 'checked' : ''} aria-label="Open for booking"></td><td><button class="btn" data-savepark="${esc(p.id)}">Save</button></td></tr>`).join('')}
      </tbody></table></div><p class="hint" id="parkMsg"></p></div>`;
  }

  async function staff() {
    const rows = await api('GET', '/v1/officer/officers');
    $('pane').innerHTML = `<div class="panel"><h2>Staff accounts</h2>
      <div class="tbl"><table><thead><tr><th>Username</th><th>Name</th><th>Agency</th><th>Role</th><th>Created</th></tr></thead><tbody>
      ${rows.map((o) => `<tr><td class="mono">${esc(o.username)}</td><td>${esc(o.name)}</td><td>${esc(o.agency)}</td><td>${esc(o.role)}</td><td class="mono">${esc(fdt(o.created_at))}</td></tr>`).join('')}</tbody></table></div></div>
      <form class="panel" id="staffForm" style="display:grid;gap:10px"><h2>Add a staff member</h2>
        <p class="hint">Case workers handle applications for their agency, counter staff run queues and park gates, admins see everything. ${S.cfg && S.cfg.tourism ? `Park gate staff use agency <span class="mono">${esc(S.cfg.tourism.parksAgency.code)}</span> and role counter.` : ''}</p>
        <div class="row"><input id="sUser" placeholder="username, e.g. gate.kasane" required class="mono"><input id="sName" placeholder="Full name" required style="flex:1;min-width:200px">
        <input id="sAgency" placeholder="Agency code" required class="mono" style="width:130px"><select id="sRole"><option>counter</option><option>caseworker</option><option>admin</option></select></div>
        <div class="row"><button class="btn sky">Create account</button><span id="staffMsg" class="hint"></span></div></form>`;
  }

  async function applications() {
    const rows = await api('GET', `/v1/officer/applications?status=${S.status}`);
    $('pane').innerHTML = `<div class="panel"><div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Applications${S.me.role === 'admin' ? '' : ' · ' + esc(S.me.agency)}</h2>
      <div class="tabs">${['open', 'completed', 'rejected'].map((s) => `<button data-status="${s}" aria-pressed="${S.status === s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div></div>
      ${rows.length ? `<div class="tbl"><table><thead><tr><th>Reference</th><th>Citizen</th><th>Service</th><th>Step</th><th>Submitted</th><th></th></tr></thead><tbody>
      ${rows.map((a) => {
        const next = a.steps[a.step + 1];
        return `<tr><td class="mono">${esc(a.ref)}</td><td>${esc(a.citizen.name)}<br><span class="hint mono">${esc(idShort())} ***${esc(a.citizen.idLast4 || a.citizen.omangLast4)}</span></td><td>${esc(a.title)}${a.data && a.data.licence_class ? `<br><span class="hint">Class ${esc(a.data.licence_class)}</span>` : ''}</td>
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
      else if (el.dataset.pstatus) { S.pstatus = el.dataset.pstatus; render(); }
      else if (el.dataset.savepark) {
        const row = el.closest('tr');
        const rates = [...row.querySelectorAll('[data-rate]')].map((i) => ({ key: i.dataset.rate, price: i.value.trim() }));
        el.disabled = true;
        await api('PUT', `/v1/officer/parks/${el.dataset.savepark}`, { active: row.querySelector('[data-active]').checked, capacity: Number(row.querySelector('[data-cap]').value), rates });
        await permits(); $('parkMsg').textContent = 'Saved.';
      }
      else if (el.dataset.checkin) { el.disabled = true; await api('POST', `/v1/officer/park-permits/${el.dataset.checkin}/check-in`); await permits(); }
      else if (el.dataset.dirdel) { el.disabled = true; await api('DELETE', `/v1/officer/directory/${el.dataset.dirdel}`); await directory(); }
      else if (el.dataset.approve) {
        const caps = [...document.querySelectorAll(`[data-cap="${el.dataset.approve}"]:checked`)].map((c) => c.value);
        el.disabled = true; await api('POST', `/v1/officer/partners/${el.dataset.approve}/approve`, { capabilities: caps }); S.pstatus = 'approved'; render();
      }
      else if (el.dataset.reinstate) { el.disabled = true; await api('POST', `/v1/officer/partners/${el.dataset.reinstate}/reinstate`, {}); S.pstatus = 'approved'; render(); }
      else if (el.dataset.pnote) { noting = { id: el.dataset.pnote, act: el.dataset.pact }; $('noteTitle').textContent = noting.act === 'reject' ? 'Reject partner application' : 'Suspend partner'; $('note').value = ''; $('noteDlg').showModal(); }
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
    if (e.target.id === 'pdate') { S.pdate = e.target.value; permits().catch((x) => alertInline(x.message)); }
    if (e.target.dataset && e.target.dataset.dirstatus) {
      const row = (S.dirRows || []).find((x) => x.id === e.target.dataset.dirstatus);
      if (row) api('PUT', `/v1/officer/directory/${row.id}`, { name: row.name, sector: row.sector, url: row.url, description: row.description, status: e.target.value, partnerCode: row.partner ? row.partner.code : undefined }).then(directory).catch((x) => alertInline(x.message));
    }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'staffForm') {
      e.preventDefault();
      try {
        const r = await api('POST', '/v1/officer/officers', { username: $('sUser').value.trim(), name: $('sName').value.trim(), agency: $('sAgency').value.trim(), role: $('sRole').value });
        await staff();
        $('staffMsg').innerHTML = `Created <b class="mono">${esc(r.username)}</b>. One-time password: <b class="mono">${esc(r.password)}</b>. Give it to them in person; it is not shown again.`;
      } catch (x) { $('staffMsg').textContent = x.message; }
      return;
    }
    if (e.target.id === 'dirForm') {
      e.preventDefault();
      try {
        await api('POST', '/v1/officer/directory', { name: $('dName').value.trim(), sector: $('dSector').value, status: $('dStatus').value, url: $('dUrl').value.trim(), description: $('dDesc').value.trim(), partnerCode: $('dPartner').value.trim() || undefined });
        await directory();
      } catch (x) { $('dirMsg').textContent = x.message; }
      return;
    }
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
  let noting = null;
  $('noteDlg').addEventListener('close', async () => {
    if ($('noteDlg').returnValue !== 'ok' || !noting) return;
    try { await api('POST', `/v1/officer/partners/${noting.id}/${noting.act}`, { note: $('note').value.trim() }); S.pstatus = noting.act === 'reject' ? 'rejected' : 'suspended'; } catch (x) { alertInline(x.message); }
    noting = null; render();
  });
  function alertInline(msg) { const p = $('pane') || $('main'); const n = document.createElement('p'); n.className = 'err'; n.textContent = msg; p.prepend(n); setTimeout(() => n.remove(), 5000); }

  setInterval(() => { if (S.token && S.me && S.tab === 'queue' && !document.querySelector('select:focus')) queue().catch(() => {}); }, 8000);

  (async () => {
    try { S.cfg = await api('GET', '/v1/config'); } catch (e) {}
    if (S.token) { try { S.me = await api('GET', '/v1/officer/me'); } catch (e) { S.token = null; ss.del('kgo.token'); } }
    render();
  })();
})();
