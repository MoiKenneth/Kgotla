/* Kgotla citizen app (installable PWA). Talks only to the Kgotla API on the same origin. */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} },
  };
  // The cell's country pack (currency, ID rules, billers, flag …) from /v1/config, cached for offline use.
  const PK = () => (S.cfg && S.cfg.pack) || FALLBACK_PACK;
  const money = (t) => { const n = Number(t) || 0; const a = Math.abs(n); return (n < 0 ? '−' : '') + PK().currency.symbol + '\u00a0' + Math.floor(a / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + String(a % 100).padStart(2, '0'); };
  // Cell local time (all Phase 1–2 countries are UTC+2, no DST).
  const loc = (x) => new Date(new Date(x).getTime() + PK().utcOffsetMinutes * 60e3);
  const MON = { en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], tn: ['Ferikgong', 'Tlhakole', 'Mopitlo', 'Moranang', 'Motsheganong', 'Seetebosigo', 'Phukwi', 'Phatwe', 'Lwetse', 'Diphalane', 'Ngwanatsele', 'Sedimonthole'] };
  const WD = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], tn: ['Sontaga', 'Mosupologo', 'Labobedi', 'Laboraro', 'Labone', 'Labotlhano', 'Lamatlhatso'] };
  const fd = (x) => { const d = loc(x); return `${d.getUTCDate()} ${MON[S.lang][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const fday = (x) => { const d = loc(x); return `${WD[S.lang][d.getUTCDay()]} ${d.getUTCDate()} ${MON[S.lang][d.getUTCMonth()]}`; };
  const ftime = (x) => loc(x).toISOString().slice(11, 16);
  const ago = (x) => { const days = Math.floor((Date.now() - new Date(x)) / 864e5); return days <= 0 ? (S.lang === 'tn' ? 'Gompieno' : 'Today') : days === 1 ? (S.lang === 'tn' ? 'Maabane' : 'Yesterday') : fd(x); };
  const daysUntil = (x) => Math.round((new Date(x) - Date.now()) / 864e5);

  const P = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', id: 'M3 6h18v12H3z M9 9.5a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2 M6.2 15.5c.6-1.4 1.7-2 2.8-2s2.2.6 2.8 2 M14 10h4 M14 13h3', vault: 'M3 7h6l2 2h10v10H3z',
    wallet: 'M3 7h15a3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M3 7l12-3v3 M16 13h2', mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 11a7 7 0 0 0 14 0 M12 18v3', bell: 'M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z M10 20a2 2 0 0 0 4 0',
    gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9L7 7 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1', back: 'M15 5l-7 7 7 7', chev: 'M9 5l7 7-7 7',
    qr: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h2v2h-2z M18 18h2v2h-2z M14 18h2 M18 14h2', send: 'M4 12l16-8-6 16-2-7z', bolt: 'M13 2L4 14h7l-1 8 9-12h-7z', phone: 'M7 2h10v20H7z M11 18h2', plus: 'M12 5v14 M5 12h14', check: 'M5 12l5 5 9-10',
    car: 'M5 15l1.5-5h11l1.5 5 M4 15h16v4H4z M7 19v2 M17 19v2', doc: 'M6 2h9l4 4v16H6z M14 2v5h5 M9 12h7 M9 16h7', person: 'M12 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6 20c0-4 2.7-7 6-7s6 3 6 7', book: 'M5 3h12a2 2 0 0 1 2 2v16H7a2 2 0 0 1-2-2z M12 9a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5',
    ticket: 'M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4z M14 6v12', cross: 'M9 3h6v6h6v6h-6v6H9v-6H3V9h6z', leaf: 'M5 19C5 9 11 4 20 4c0 9-5 15-15 15z M5 19l8-8', cap: 'M2 9l10-5 10 5-10 5z M6 11v5c3 2 9 2 12 0v-5', brief: 'M3 7h18v13H3z M8 7V4h8v3 M3 12h18',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5 4.5-5', share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M8.6 13.5l6.8 4 M15.4 6.5l-6.8 4', x: 'M6 6l12 12 M18 6L6 18',
    receipt: 'M6 2h12v20l-3-2-3 2-3-2-3 2z M9 7h6 M9 11h6 M9 15h4', drop: 'M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z', down: 'M12 4v14 M6 12l6 6 6-6', help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6 M12 17h.01',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2', face: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M9 10h.01 M15 10h.01 M8.5 14.5c1 1.3 2.2 2 3.5 2s2.5-.7 3.5-2', users: 'M9 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6 M16 4a3 3 0 0 1 0 6 M18 14c2 .8 3 3 3 6',
    lang: 'M4 5h9 M8.5 3v2 M6 5c.8 3.5 3 6 6 7.5 M11 5c-.8 3.5-3 6-6 7.5 M13 20l4-9 4 9 M14.5 17h5', out: 'M15 4h4v16h-4 M10 8l-4 4 4 4 M6 12h10',
  };
  /** Used only until /v1/config has loaded once (first ever open, offline). */
  const FALLBACK_PACK = {
    code: 'BW', name: 'Botswana', currency: { code: 'BWP', symbol: 'P' }, utcOffsetMinutes: 120, languages: [{ code: 'en', name: 'English' }], plannedLanguages: [],
    nationalId: { name: 'ID number', short: 'ID', example: '', inputMode: 'text', maxLength: 16 }, phone: { cc: '', example: '' }, ussdCode: '*321#',
    agencies: { licence: { code: '', name: '' }, civil: { code: '', name: '' }, tax: { code: '', name: '' } }, licence: { classWord: 'Class', collectAt: '' },
    billers: [], topUpSources: [], chips: { send: [], bills: [], airtime: [], topup: [] }, demo: null,
  };
  const ic = (n, s = 20, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true"><path d="${P[n] || ''}"/></svg>`;

  // ------------------------------------------------------------------ state
  const D = window.KGOTLA_I18N;
  const S = {
    lang: store.get('kg.lang') || 'en',
    token: store.get('kg.token'),
    me: null,
    cfg: null,
    offline: false,
    stack: [],
    chat: [],
    dataSaver: store.get('kg.saver') === '1',
    readAloud: store.get('kg.read') === '1',
  };
  try { S.me = JSON.parse(store.get('kg.me') || 'null'); } catch (e) {}
  try { S.cfg = JSON.parse(store.get('kg.cfg') || 'null'); } catch (e) {}
  try { S.chat = JSON.parse(sessionStorage.getItem('kg.chat') || '[]'); } catch (e) {}
  const UI = { sheet: null, toast: null, busy: false, typing: false, listening: false };
  /** Cell-wide words for the copy: ID name, agencies, USSD code. */
  const GLOBALS = () => { const p = PK(); return { idName: p.nationalId.name, idShort: p.nationalId.short, lic: p.agencies.licence.code, tax: p.agencies.tax.code, civil: p.agencies.civil.name, ussd: p.ussdCode, cur: p.currency.symbol, curCode: p.currency.code, country: p.name }; };
  const t = (k, v) => { let s = (D[S.lang] && D[S.lang][k]) || D.en[k] || k; const all = Object.assign(GLOBALS(), v || {}); for (const x in all) s = s.split('{' + x + '}').join(all[x]); return s; };
  /** Language buttons for the languages this cell's app is translated into. */
  const langPills = (cls) => { const ls = PK().languages; return ls.length < 2 ? '' : ls.map((l) => `<button class="${cls}" aria-pressed="${S.lang === l.code}" data-a="lang" data-val="${l.code}">${cls === 'pill' ? esc(l.name) : esc(l.code.toUpperCase())}</button>`).join(''); };
  const flag = () => window.kgotlaFlag ? window.kgotlaFlag(PK().code) : '';
  const cur = () => S.stack[S.stack.length - 1] || { v: 'welcome', p: {} };

  // ------------------------------------------------------------------ API
  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(path, {
        method,
        headers: Object.assign({ 'content-type': 'application/json' }, S.token ? { authorization: 'Bearer ' + S.token } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      S.offline = true;
      throw { code: 'offline', message: t('offlineMsg') };
    }
    if (S.offline) { S.offline = false; }
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (r.status === 401 && j.error && j.error.code === 'unauthorized' && S.token) { signOutLocal(); throw j.error; }
    if (!r.ok) throw j.error || { code: 'http_' + r.status, message: t('somethingWrong') };
    return j;
  }

  async function refresh(opts) {
    if (!S.token) return;
    try {
      S.me = await api('GET', '/v1/me');
      store.set('kg.me', JSON.stringify(S.me));
      if (S.me.profile.lang && S.me.profile.lang !== S.lang && !(opts && opts.keepLang)) { S.lang = S.me.profile.lang; store.set('kg.lang', S.lang); }
    } catch (e) { if (e.code !== 'offline') throw e; }
    if (!opts || opts.render !== false) render();
  }

  function signOutLocal() {
    S.token = null; S.me = null; S.chat = [];
    store.del('kg.token'); store.del('kg.me');
    try { sessionStorage.removeItem('kg.chat'); } catch (e) {}
    S.stack = [{ v: 'welcome', p: {} }];
    render(true);
  }

  // ------------------------------------------------------------------ navigation
  const TABS = ['home', 'id', 'vault', 'pay', 'assist'];
  function go(v, p) { S.stack.push({ v, p: p || {} }); render(true); }
  function replace(v, p) { S.stack[S.stack.length - 1] = { v, p: p || {} }; render(true); }
  function tab(v) { S.stack = [{ v, p: {} }]; render(true); if (S.token) refresh({ render: false }).then(() => { if (cur().v === v) render(); }).catch(() => {}); }
  function back() { if (S.stack.length > 1) S.stack.pop(); render(true); }
  function toast(msg) { UI.toast = msg; render(); clearTimeout(toast.t); toast.t = setTimeout(() => { UI.toast = null; render(); }, 2800); }
  function fail(e) { UI.busy = false; toast((e && e.message) || t('somethingWrong')); }

  // ------------------------------------------------------------------ confirmable actions
  async function prepare(type, params) {
    if (UI.busy) return;
    UI.busy = true; render();
    try {
      const a = await api('POST', '/v1/actions', { type, params });
      UI.busy = false;
      go('review', { action: a });
    } catch (e) { fail(e); }
  }

  function askPin(readback, onPin) {
    UI.sheet = { readback, entered: '', busy: false, error: '', onPin };
    render();
  }

  async function confirmAction(a) {
    const run = async (pin) => {
      const r = await api('POST', `/v1/actions/${a.id}/confirm`, pin ? { pin } : {});
      UI.sheet = null;
      replace('done', { action: r });
      refresh({ render: false }).then(() => render()).catch(() => {});
    };
    if (a.requiresPin) return askPin(a.readback, run);
    UI.busy = true; render();
    try { await run(); } catch (e) { fail(e); }
    UI.busy = false;
  }

  // ------------------------------------------------------------------ small view helpers
  const tile = (icon, key, v, k, cls) => `<button class="tile ${cls || ''}" data-a="go" data-v="${v}"${k ? ` data-k="${k}"` : ''}>${ic(icon, 20)}<span>${esc(t(key))}</span></button>`;
  const soon = (icon, key, p) => `<div class="tile soon">${ic(icon, 20)}<span>${esc(t(key))}</span><span class="soon-tag">${esc(t('soon', { p }))}</span></div>`;
  const txRow = (x) => `<div class="row">${ic(x.amount > 0 ? 'down' : 'send', 20, 'lead')}<span class="main"><b>${esc(x.title)}</b><small>${esc(ago(x.at))}</small></span><span class="val ${x.amount > 0 ? 'in' : ''}">${x.amount > 0 ? '+' : ''}${money(x.amount)}</span></div>`;
  const readbackHtml = (rows) => `<div class="readback">${rows.map(([a, b]) => `<div class="rb"><span>${esc(a)}</span><span>${esc(b)}</span></div>`).join('')}</div>`;
  const stepLabel = (s) => (S.lang === 'tn' && s.label_tn) || s.label;
  /** National ID field shaped by this cell's rules (digits only, or letters and slashes). */
  const idInput = (p, ac) => { const n = PK().nationalId; return `<input id="omang" class="big mono" inputmode="${n.inputMode}" autocomplete="${ac}" autocapitalize="characters" maxlength="${n.maxLength}" placeholder="${esc(n.example)}" value="${esc(p.omang || '')}">`; };
  const btn = (label, a, extra, cls) => `<button class="btn ${cls || ''}" data-a="${a}" ${extra || ''} ${UI.busy ? 'disabled' : ''}>${label}</button>`;
  const loading = () => `<div class="skeleton"></div><div class="skeleton"></div>`;
  const onceLoad = (p, key, fn) => { if (!p[key + '_state']) { p[key + '_state'] = 'loading'; fn().then((v) => { p[key] = v; p[key + '_state'] = 'ok'; render(); }).catch((e) => { p[key + '_state'] = 'error'; p[key + '_error'] = e.message; render(); }); } return p[key + '_state'] === 'ok'; };

  // ------------------------------------------------------------------ views
  const V = {};

  // ---- signed out
  V.welcome = () => ({
    raw: `<div class="ob"><div class="flagbar" title="${esc(PK().name)}">${flag()}</div>
      <h2>${t('welcomeT')}</h2><p>${t('welcomeB')}</p><div class="grow"></div>
      ${PK().languages.length > 1 ? `<div class="field"><label>${t('chooseLang')}</label><div class="pills">${langPills('pill')}</div></div>` : ''}
      <button class="btn sky" data-a="go" data-v="enrol">${t('createAccount')}</button>
      <button class="btn ghost" data-a="go" data-v="login">${t('signIn')}</button>
      <p class="hint center">${t('ussdHint')}</p></div>`,
  });

  V.login = (p) => {
    p.pin = p.pin || '';
    const demo = S.cfg && S.cfg.demoMode;
    return {
      raw: `<div class="ob"><button class="iconbtn" data-a="back" aria-label="${t('back')}">${ic('back', 22)}</button>
        <h2>${t('signIn')}</h2><p>${t('signInB')}</p>
        <div class="field"><label for="omang">${t('omang')}</label>${idInput(p, 'username')}</div>
        <div class="pindots" aria-label="${t('pin')}">${[0, 1, 2, 3].map((i) => `<i class="${p.pin.length > i ? 'on' : ''}"></i>`).join('')}</div>
        ${p.error ? `<p class="err center">${esc(p.error)}</p>` : ''}
        ${demo && PK().demo ? `<div class="demo-box">${PK().demo.citizens.slice(0, 2).map((c) => `Demo: ${esc(PK().nationalId.short)} <b>${esc(c.id)}</b> · PIN <b>${esc(c.pin)}</b> (${esc(c.name)})`).join('<br>')}</div>` : ''}
        <div class="grow"></div>
        <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => (k === '' ? '<span></span>' : `<button data-a="loginKey" data-val="${k}">${k}</button>`)).join('')}</div></div>`,
    };
  };

  V.enrol = (p) => {
    p.step = p.step || 'omang';
    const bar = `<div class="obsteps">${['omang', 'otp', 'face', 'pin', 'done'].map((s, i, a) => `<i class="${i <= a.indexOf(p.step) ? 'on' : ''}"></i>`).join('')}</div>`;
    const head = `<button class="iconbtn" data-a="back" aria-label="${t('back')}">${ic('back', 22)}</button>${bar}`;
    const err = p.error ? `<p class="err">${esc(p.error)}</p>` : '';
    if (p.step === 'omang') return { raw: `<div class="ob">${head}<h2>${t('ob2T')}</h2><p>${t('ob2B')}</p><div class="field"><label for="omang">${t('omang')}</label>${idInput(p, 'off')}</div>${err}${S.cfg && S.cfg.demoMode && PK().demo ? `<div class="demo-box">Demo: try ${PK().demo.signups.map((x) => `<b>${esc(x.id)}</b> (${esc(x.name.split(' ')[0])})`).join(' or ')}</div>` : ''}<div class="grow"></div>${btn(t('cont'), 'enrolStart', '', 'sky')}</div>` };
    if (p.step === 'otp') return { raw: `<div class="ob">${head}<h2>${t('otpT')}</h2><p>${t('otpB', { p: esc(p.phoneMasked) })}</p><div class="field"><input id="otp" class="big mono" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></div>${err}${p.demoOtp ? `<div class="demo-box">${t('demoCode')}: <b>${esc(p.demoOtp)}</b></div>` : ''}<div class="grow"></div>${btn(t('cont'), 'enrolOtp', '', 'sky')}</div>` };
    if (p.step === 'face') {
      return {
        raw: `<div class="ob">${head}<h2>${t('ob3T')}</h2><p>${t('ob3B')}</p>
          <div class="cam ${p.faceOk ? 'ok' : ''}" id="cam">${p.shot ? `<img src="${p.shot}" alt="">` : p.camOn ? '<video id="video" autoplay playsinline muted></video>' : ic('face', 70)}</div>
          ${p.faceOk ? `<p class="center" style="color:var(--good);font-weight:600">${t('faceOk')}</p>` : ''}${err}
          <div class="grow"></div>
          ${p.faceOk ? btn(t('cont'), 'enrolStep', 'data-val="pin"', 'sky')
            : p.camOn ? btn(t('capture'), 'enrolCapture', '', 'sky')
            : `${btn(t('startCam'), 'enrolCam', '', 'sky')}<label class="btn ghost" for="selfieFile">${t('upload')}</label><input id="selfieFile" type="file" accept="image/*" capture="user" hidden>`}
        </div>`,
      };
    }
    if (p.step === 'pin') {
      p.pin = p.pin || '';
      return { raw: `<div class="ob">${head}<h2>${p.first ? t('ob4Again') : t('ob4T')}</h2><p>${t('ob4B')}</p><div class="pindots">${[0, 1, 2, 3].map((i) => `<i class="${p.pin.length > i ? 'on' : ''}"></i>`).join('')}</div>${err}<div class="grow"></div><div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => (k === '' ? '<span></span>' : `<button data-a="enrolPin" data-val="${k}">${k}</button>`)).join('')}</div></div>` };
    }
    return { raw: `<div class="ob">${bar}<div class="big-ok"><div class="ring">${ic('shield', 32)}</div><h4>${t('ob5T')}</h4><p>${t('ob5B')}</p></div><div class="grow"></div><button class="btn sky" data-a="tab" data-v="home">${t('openApp')}</button></div>` };
  };

  // ---- partner requests: consent and bills from clinics, banks and others
  const requestsHtml = (m) => {
    const cs = m.consentRequests || []; const bs = m.bills || [];
    if (!cs.length && !bs.length) return '';
    return `<h3 class="sec">${t('reqT')}</h3>` + cs.map((c) => `<div class="card req">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="chip">${ic('shield', 12)} ${esc(c.partner.typeLabel)}</span><small style="color:var(--muted)">${esc(t('until', { d: fd(c.expiresAt) }))}</small></div>
        <p style="font-weight:700">${esc(t('reqAsk', { p: c.partner.name }))}</p>
        <ul class="scopes">${c.scopes.map((x) => `<li>${ic('check', 14)}<span>${esc(x.description)}</span></li>`).join('')}</ul>
        <p style="font-size:12.5px;color:var(--muted)">${esc(t('purpose'))}: ${esc(c.purpose)} · ${esc(t('licensedBy', { r: c.partner.regulator.split(' · ')[0] }))}</p>
        <div class="btns"><button class="btn sm" data-a="consentApprove" data-id="${c.id}">${ic('shield', 16)} ${t('approvePin')}</button><button class="btn sm ghost" data-a="consentDecline" data-id="${c.id}">${t('decline')}</button></div></div>`).join('')
      + bs.map((b) => `<div class="card req">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="chip warn">${ic('receipt', 12)} ${esc(t('billFrom', { p: b.partner }))}</span><b style="font-size:18px">${money(b.amount)}</b></div>
        <p style="font-weight:600">${esc(b.description)}</p><p style="font-size:12.5px;color:var(--muted)">${esc(t('ref'))} <span class="mono">${esc(b.reference)}</span> · ${esc(t('until', { d: fd(b.expiresAt) }))}</p>
        <div class="btns"><button class="btn sm" data-a="billPay" data-id="${b.id}">${t('payBill')} ${money(b.amount)}</button><button class="btn sm ghost" data-a="billDecline" data-id="${b.id}">${t('decline')}</button></div></div>`).join('');
  };

  // ---- home
  V.home = () => {
    const m = S.me; if (!m) return { body: loading() };
    const lic = m.documents.find((d) => d.type === 'driver_licence');
    const renewing = m.applications.some((a) => a.service === 'driver_licence_renewal' && a.status === 'open');
    const dleft = lic && lic.valid_to ? daysUntil(lic.valid_to) : null;
    let h = `<div class="greet"><b>${esc(t('hello', { n: m.profile.firstName }))}</b><small>${esc(fday(new Date()))} · ${esc(m.profile.district)}</small></div>
      <div class="wallet"><div><div class="lbl">${t('balance')}</div><div class="amt">${money(m.balance)}</div></div>
      <div class="qa"><button data-a="go" data-v="send">${ic('send', 18)}${t('send')}</button><button data-a="go" data-v="bills">${ic('bolt', 18)}${t('bills')}</button><button data-a="go" data-v="airtime">${ic('phone', 18)}${t('airtime')}</button><button data-a="go" data-v="topup">${ic('down', 18)}${t('topup')}</button></div></div>`;
    h += requestsHtml(m);
    if (lic && dleft !== null && dleft <= 60 && !renewing) {
      h += `<div class="nudge"><span class="chip warn">${ic('clock', 12)} ${fd(lic.valid_to)}</span><div class="t">${esc(t('nudgeT', { d: Math.max(0, dleft) }))}</div><p style="font-size:13px;color:var(--muted)">${esc(t('nudgeB'))}</p><div class="btns"><button class="btn sm" data-a="go" data-v="licence">${t('renewNow')}</button><button class="btn sm ghost" data-a="assistSay" data-k="sug1">${ic('mic', 16)} ${t('askAssist')}</button></div></div>`;
    }
    if (m.queue) {
      const q = m.queue;
      h += `<button class="card" data-a="go" data-v="queue" style="text-align:left"><div style="display:flex;justify-content:space-between;align-items:center"><span class="chip">${ic('ticket', 12)} ${t('yourTicket')}</span><b class="mono" style="font-size:20px">${esc(q.label)}</b></div><p style="font-weight:600">${q.status === 'called' ? esc(t('nextUp', { c: q.counter })) : esc(t('ahead', { n: q.ahead }))}</p><p style="font-size:12.5px;color:var(--muted)">${esc(q.office)} · ${esc(q.service)}</p></button>`;
    }
    m.applications.filter((a) => a.status === 'open').forEach((a) => {
      h += `<button class="card" data-a="go" data-v="tracker" data-id="${a.id}" style="text-align:left"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="chip">${t('inProgress')}</span><span class="mono" style="font-size:11.5px;color:var(--muted)">${esc(a.ref)}</span></div><p style="font-weight:600">${esc(a.title)}</p><p style="font-size:12.5px;color:var(--muted)">${esc(stepLabel(a.steps[a.step]))} · ${a.step + 1}/${a.steps.length}</p></button>`;
    });
    const ap = m.appointments[0];
    if (ap) h += `<div class="card"><span class="chip good">${ic('clock', 12)} ${t('upcoming')}</span><p style="font-weight:600">${esc(ap.where)}</p><p style="font-size:12.5px;color:var(--muted)">${esc(fday(ap.starts_at))} · ${esc(ftime(ap.starts_at))} · ${esc(ap.purpose)}</p></div>`;
    h += `<h3 class="sec">${t('govSvc')}</h3><div class="tiles">${tile('car', 'sLic', 'licence')}${tile('receipt', 'sTax', 'tax')}${tile('person', 'sBirth', 'birth')}${tile('book', 'sPass', 'booking', 'passport')}${tile('ticket', 'sQueue', 'queue')}${tile('cross', 'sClinic', 'booking', 'clinic')}</div>
      <h3 class="sec">${t('recent')}</h3><div class="list">${m.transactions.slice(0, 3).map(txRow).join('')}<button class="row" data-a="tab" data-v="pay"><span class="main"><b style="color:var(--sky)">${t('seeAll')}</b></span>${ic('chev', 16)}</button></div>`;
    return { body: h };
  };

  V.services = () => ({
    title: t('services'),
    body: `<h3 class="sec">${t('govSvc')}</h3><div class="tiles">${tile('car', 'sLic', 'licence')}${tile('receipt', 'sTax', 'tax')}${tile('person', 'sBirth', 'birth')}${tile('book', 'sPass', 'booking', 'passport')}${tile('ticket', 'sQueue', 'queue')}</div>
      <h3 class="sec">${t('money')}</h3><div class="tiles">${tile('send', 'send', 'send', '', 'money')}${tile('bolt', 'bills', 'bills', '', 'money')}${tile('phone', 'airtime', 'airtime', '', 'money')}</div>
      <h3 class="sec">${t('health')}</h3><div class="tiles">${tile('cross', 'sClinic', 'booking', 'clinic')}</div>
      <h3 class="sec">${t('farming')}</h3><div class="tiles">${soon('leaf', 'sAgri', 'Phase 1B')}</div>
      <h3 class="sec">${t('learning')} · ${t('work')}</h3><div class="tiles">${soon('cap', 'sSchool', 'Phase 2')}${soon('brief', 'sJobs', 'Phase 2')}</div>
      <p class="hint">${t('ussdHint')}</p>`,
  });

  // ---- identity
  V.id = () => {
    const m = S.me; if (!m) return { title: t('id'), body: loading() };
    const u = m.profile;
    return {
      title: t('id'),
      body: `<div class="idcard"><div class="stripe" style="background:${window.kgotlaBands ? window.kgotlaBands(PK().code) : 'var(--sky)'}"></div>
        <div class="body"><div class="avatar">${esc(u.firstName[0])}${esc(u.lastName[0])}</div>
        <dl><dt>${t('fName')}</dt><dd>${esc(u.firstName + ' ' + u.lastName)}</dd><dt>${esc(PK().nationalId.short)}</dt><dd class="mono">••••• ${esc(u.idLast4 || u.omangLast4)}</dd><dt>${t('fDob')}</dt><dd>${fd(u.dob + 'T12:00:00Z')}</dd><dt>${t('fAddr')}</dt><dd>${esc(u.district)}</dd></dl></div>
        <div class="foot"><span style="display:flex;gap:6px;align-items:center;color:var(--good)">${ic('shield', 16)} ${t('verified')}</span><span class="chip">${esc(t('loa', { n: u.loa }))}</span></div></div>
        <button class="btn" data-a="go" data-v="idShare" data-k="full">${ic('qr', 18)} ${t('showQR')}</button>
        <button class="btn ghost" data-a="go" data-v="idShare" data-k="pick">${ic('share', 18)} ${t('shareSel')}</button>
        <h3 class="sec">${t('consentLog')}</h3>
        <div class="list">${m.disclosures.length ? m.disclosures.map((d) => `<div class="row">${ic('users', 20, 'lead')}<span class="main"><b>${esc(d.audience)}</b><small>${esc(d.claims.map(claimName).join(', '))} · ${esc(ago(d.created_at))}${d.verified_at ? ' · ✓' : ''}</small></span></div>`).join('') : `<div class="row"><span class="main"><small>${t('noneYet')}</small></span></div>`}</div>`,
    };
  };
  const CLAIMS = [['name', 'fName'], ['photo', 'fPhoto'], ['dob', 'fDob'], ['over18', 'fOver18'], ['district', 'fAddr'], ['id_last4', 'fOmang']];
  const claimName = (c) => t((CLAIMS.find((x) => x[0] === c) || [c, c])[1]);
  V.idShare = (p) => {
    if (!p.fields) p.fields = p.k === 'full' ? { name: 1, photo: 1, id_last4: 1 } : p.k === 'over18' ? { over18: 1 } : { name: 1, over18: 1 };
    let body = `<div class="list">${CLAIMS.map(([k, l]) => `<button class="toggle" role="switch" aria-checked="${p.fields[k] ? 'true' : 'false'}" data-a="fieldToggle" data-k="${k}"><span class="main"><b style="font-weight:600;font-size:14px">${t(l)}</b></span><span class="sw"></span></button>`).join('')}</div>`;
    if (p.code) {
      const left = Math.max(0, Math.ceil((new Date(p.code.expiresAt) - Date.now()) / 1000));
      body = `<div class="qrbox">${left > 0 ? qrSvg(p.code.qr) : `<div style="height:210px;display:grid;place-items:center;color:#55626f">${t('expired')}</div>`}<span class="cd" data-countdown="${new Date(p.code.expiresAt).getTime()}">${left > 0 ? t('expiresIn', { s: left }) : t('expired')}</span></div>
        <p class="say">${ic('shield', 16)} ${t('scanNote')}</p>` + body + btn(`${ic('qr', 18)} ${t('newCode')}`, 'makeCode');
    } else body += btn(`${ic('qr', 18)} ${t('makeCode')}`, 'makeCode', Object.values(p.fields).some(Boolean) ? '' : 'disabled');
    return { title: t('shareSel'), body };
  };
  function qrSvg(text) {
    try {
      const q = window.qrcode(0, 'M');
      q.addData(text);
      q.make();
      return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'Kgotla identity code' });
    } catch (e) { return `<p class="err">QR error</p>`; }
  }

  // ---- vault
  V.vault = () => {
    const m = S.me; if (!m) return { title: t('vault'), body: loading() };
    return {
      title: t('vault'),
      body: `<div class="list">${m.documents.map((d) => {
        const exp = d.valid_to && daysUntil(d.valid_to) <= 60;
        return `<button class="row" data-a="go" data-v="doc" data-id="${d.id}">${ic(docIcon(d.type), 20, 'lead')}<span class="main"><b>${esc(d.title)}</b><small>${esc(d.issuer)}</small></span>${exp ? `<span class="chip warn">${fd(d.valid_to)}</span>` : `<span class="chip good">${ic('check', 11)}</span>`}</button>`;
      }).join('')}</div>
      <p class="say">${ic('shield', 16)} ${S.lang === 'tn' ? 'Makalana a ntsha makwalo ka tlhamalalo mo Polokelong ya gago.' : 'Institutions issue documents straight into your Vault. No photocopies, no certification stamps.'}</p>`,
    };
  };
  const docIcon = (type) => ({ omang: 'id', driver_licence: 'car', tax_clearance: 'receipt', birth_certificate: 'person' })[type] || 'doc';
  V.doc = (p) => {
    const d = S.me && S.me.documents.find((x) => x.id === p.id); if (!d) return { title: t('docs'), body: '' };
    const exp = d.valid_to && daysUntil(d.valid_to) <= 60;
    const share = p.share || (d.active_share ? { id: d.active_share.id, expiresAt: d.active_share.expiresAt, url: null } : null);
    return {
      title: t('docs'),
      body: `<div class="docpaper"><span>${ic(docIcon(d.type), 28)}</span><h4>${esc(d.title)}</h4><dl>
        <dt>${t('issuedBy')}</dt><dd>${esc(d.issuer)}</dd><dt>${t('issued')}</dt><dd>${fd(d.issued_at)}</dd>${d.valid_to ? `<dt>${t('validTo')}</dt><dd>${fd(d.valid_to)}</dd>` : ''}${d.ref ? `<dt>Ref</dt><dd class="mono">${esc(d.ref)}</dd>` : ''}
        <dt>${t('status')}</dt><dd>${exp ? `<span class="chip warn">${t('expiring')}</span>` : `<span class="chip good">${t('valid')}</span>`}</dd></dl></div>
        ${d.type === 'driver_licence' && exp && !S.me.applications.some((a) => a.service === 'driver_licence_renewal' && a.status === 'open') ? `<button class="btn sky" data-a="go" data-v="licence">${t('renewNow')}</button>` : ''}
        ${share ? `${share.url ? `<div class="copyrow"><code id="sharelink">${esc(share.url)}</code><button class="btn sm ghost" data-a="copyLink">${t('copy')}</button></div>` : ''}<p class="say">${ic('clock', 16)} ${t('linkNote')} · ${fday(share.expiresAt)} ${ftime(share.expiresAt)}</p>${btn(t('revoke'), 'revokeLink', `data-id="${share.id}"`, 'ghost')}`
        : btn(`${ic('share', 18)} ${t('share24')}`, 'shareDoc', `data-id="${d.id}"`)}`,
    };
  };

  // ---- pay
  V.pay = () => {
    const m = S.me; if (!m) return { title: t('pay'), body: loading() };
    return {
      title: t('pay'),
      body: `<div class="wallet"><div><div class="lbl">${t('balance')}</div><div class="amt">${money(m.balance)}</div></div>
        <div class="qa"><button data-a="go" data-v="send">${ic('send', 18)}${t('send')}</button><button data-a="go" data-v="bills">${ic('bolt', 18)}${t('bills')}</button><button data-a="go" data-v="airtime">${ic('phone', 18)}${t('airtime')}</button><button data-a="go" data-v="topup">${ic('down', 18)}${t('topup')}</button></div></div>
        <h3 class="sec">${t('allTx')}</h3><div class="list">${m.transactions.map(txRow).join('') || `<div class="row"><span class="main"><small>${t('noneYet')}</small></span></div>`}</div>`,
    };
  };
  const amountField = (p, chips) => `<div class="field"><label for="amt">${t('amount')}</label><input id="amt" class="big" inputmode="decimal" value="${esc(p.amt || '')}" placeholder="0.00"></div><div class="pills">${chips.map((v) => `<button class="pill" data-a="setAmt" data-val="${v}">${esc(PK().currency.symbol)}${v}</button>`).join('')}</div>`;
  V.send = (p) => {
    const ok = onceLoad(p, 'contacts', () => api('GET', '/v1/me/contacts'));
    return {
      title: t('send'),
      body: `<h3 class="sec">${t('recipient')}</h3>${ok ? `<div style="display:grid;gap:8px">${p.contacts.map((c) => `<button class="opt" aria-pressed="${p.to === c.phone}" data-a="pick" data-f="to" data-val="${esc(c.phone)}">${ic('person', 20)}<span class="main"><b>${esc(c.name)}</b><small>${esc(c.phone)}</small></span></button>`).join('')}</div>` : loading()}
        <div class="field"><label for="toNum">${t('orNumber')}</label><input id="toNum" inputmode="tel" placeholder="71 234 567" value="${p.to && !(p.contacts || []).some((c) => c.phone === p.to) ? esc(p.to) : ''}"></div>
        ${amountField(p, PK().chips.send)}${btn(t('review'), 'sendReview')}`,
    };
  };
  V.bills = (p) => {
    const billers = PK().billers.filter((b) => b.category !== 'airtime');
    if (!billers.some((b) => b.id === p.biller)) p.biller = billers[0].id;
    const b = billers.find((x) => x.id === p.biller);
    return {
      title: t('bills'),
      body: `<div style="display:grid;gap:8px">${billers.map((x) => `<button class="opt" aria-pressed="${p.biller === x.id}" data-a="pick" data-f="biller" data-val="${x.id}">${ic(x.category === 'electricity' ? 'bolt' : 'drop', 20)}<span class="main"><b>${esc(x.name)}</b></span></button>`).join('')}</div>
        <div class="field"><label for="bref">${esc(b.refLabel)}</label><input id="bref" class="mono" value="${esc(p.ref || '')}" placeholder="${esc(b.placeholder)}"></div>
        ${amountField(p, PK().chips.bills)}${btn(t('review'), 'billReview')}`,
    };
  };
  V.airtime = (p) => {
    const nets = PK().billers.filter((b) => b.category === 'airtime');
    if (!nets.some((n) => n.id === p.net)) p.net = nets[0].id;
    return {
      title: t('airtime'),
      body: `<div class="field"><label>${t('network')}</label><div class="pills">${nets.map((n) => `<button class="pill" aria-pressed="${p.net === n.id}" data-a="pick" data-f="net" data-val="${n.id}">${esc(n.name)}</button>`).join('')}</div></div>
        <div class="opt" aria-pressed="true">${ic('phone', 20)}<span class="main"><b>${t('myNumber')}</b><small>${esc(S.me ? S.me.profile.phoneMasked : '')}</small></span></div>
        ${amountField(p, PK().chips.airtime)}${btn(t('review'), 'airReview')}`,
    };
  };
  V.topup = (p) => {
    const sources = PK().topUpSources;
    if (!sources.some((x) => x.id === p.src)) p.src = sources[0].id;
    return {
      title: t('topup'),
      body: `<div class="field"><label>${t('source')}</label><div style="display:grid;gap:8px">${sources.map((x) => `<button class="opt" aria-pressed="${p.src === x.id}" data-a="pick" data-f="src" data-val="${x.id}">${ic('phone', 20)}<span class="main"><b>${esc(x.name)}</b></span></button>`).join('')}</div></div>
        ${amountField(p, PK().chips.topup)}${btn(t('review'), 'topReview')}`,
    };
  };

  // ---- generic review / done
  V.review = (p) => {
    const a = p.action;
    return {
      title: t('review'),
      body: `${readbackHtml(a.readback)}<p class="say">${ic('help', 16)} ${t('rbIntro')}</p>
        ${a.source === 'assistant' ? `<p class="hint">${S.lang === 'tn' ? 'E baakantswe ke mothusi.' : 'Prepared by the assistant.'}</p>` : ''}
        ${btn(a.requiresPin ? `${ic('shield', 18)} ${t('confirmPin')}` : t('confirm'), 'confirmAction')}
        <button class="btn ghost" data-a="cancelAction">${t('cancel')}</button>`,
    };
  };
  V.done = (p) => {
    const a = p.action; const r = a.result || {};
    return {
      title: t('done'),
      body: `<div class="big-ok"><div class="ring">${ic('check', 30)}</div><h4>${esc(a.status === 'done' ? (S.lang === 'tn' ? 'Go dirilwe' : 'Done') : a.status)}</h4><p>${esc(r.message || '')}</p></div>
        ${r.token ? `<div class="card"><small style="color:var(--muted)">${t('resultToken')}</small><b class="mono" style="font-size:19px;letter-spacing:.04em">${esc(r.token)}</b></div>` : ''}
        ${r.applicationId ? `<button class="btn ghost" data-a="go" data-v="tracker" data-id="${r.applicationId}">${t('track')}</button>` : ''}
        <button class="btn" data-a="tab" data-v="home">${t('done')}</button>`,
    };
  };

  // ---- government services
  V.licence = (p) => {
    const ok = onceLoad(p, 'locs', async () => {
      const locs = await api('GET', '/v1/locations?kind=eye_test');
      return Promise.all(locs.map(async (l) => ({ ...l, avail: await api('GET', `/v1/locations/${l.id}/availability`) })));
    });
    const lic = S.me && S.me.documents.find((d) => d.type === 'driver_licence');
    let slots = '';
    if (ok) {
      const items = p.locs.flatMap((l) => l.avail.days.flatMap((d) => d.slots.filter((s) => s.available).map((s) => ({ l, s })))).slice(0, 8);
      slots = items.length ? `<div style="display:grid;gap:8px">${items.map(({ l, s }) => `<button class="opt" aria-pressed="${p.slot === l.id + '|' + s.startsAt}" data-a="pick" data-f="slot" data-val="${l.id}|${s.startsAt}">${ic('clock', 20)}<span class="main"><b>${esc(fday(s.startsAt))} · ${esc(ftime(s.startsAt))}</b><small>${esc(l.name)}</small></span></button>`).join('')}</div>` : `<p class="hint">${t('noSlots')}</p>`;
    } else slots = p.locs_state === 'error' ? `<p class="err">${esc(p.locs_error)}</p>` : loading();
    return {
      title: t('sLic'),
      body: `${lic ? `<div class="card"><small style="color:var(--muted)">${esc(lic.title)}</small><b>${esc(S.me.profile.firstName + ' ' + S.me.profile.lastName)}</b><p style="font-size:13px">${t('validTo')}: ${fd(lic.valid_to)}</p></div>` : ''}
        <h3 class="sec">${t('pickSlot')}</h3>${slots}${btn(t('cont'), 'licReview', p.slot ? '' : 'disabled')}`,
    };
  };
  V.tax = () => ({ title: t('sTax'), body: `<div class="card"><b>${t('sTax')}</b><p style="font-size:13px;color:var(--muted)">${t('taxB')}</p></div>${btn(t('cont'), 'prep', 'data-k="tax_clearance"')}` });
  V.birth = () => ({ title: t('sBirth'), body: `<div class="card"><b>${t('sBirth')}</b><p style="font-size:13px;color:var(--muted)">${t('birthB')}</p></div>${btn(t('cont'), 'prep', 'data-k="birth_certificate"')}` });
  V.booking = (p) => {
    const kind = p.k === 'passport' ? 'passport' : 'clinic';
    const ok = onceLoad(p, 'locs', async () => {
      const locs = await api('GET', `/v1/locations?kind=${kind}`);
      return Promise.all(locs.map(async (l) => ({ ...l, avail: await api('GET', `/v1/locations/${l.id}/availability`) })));
    });
    if (!ok) return { title: t(kind === 'clinic' ? 'sClinic' : 'sPass'), body: p.locs_state === 'error' ? `<p class="err">${esc(p.locs_error)}</p>` : loading() };
    p.loc = p.loc || p.locs[0].id;
    const l = p.locs.find((x) => x.id === p.loc);
    p.day = p.day == null ? 0 : Number(p.day);
    const day = l.avail.days[p.day];
    return {
      title: t(kind === 'clinic' ? 'sClinic' : 'sPass'),
      body: `<div class="field"><label>${t('office')}</label><div style="display:grid;gap:8px">${p.locs.map((x) => `<button class="opt" aria-pressed="${p.loc === x.id}" data-a="pick" data-f="loc" data-val="${x.id}" data-reset="slot">${ic(kind === 'clinic' ? 'cross' : 'book', 20)}<span class="main"><b>${esc(x.name)}</b></span></button>`).join('')}</div></div>
        <div class="field"><label>${t('day')}</label><div class="pills">${l.avail.days.map((d, i) => `<button class="pill" aria-pressed="${p.day === i}" data-a="pick" data-f="day" data-val="${i}" data-reset="slot">${esc(fday(d.date + 'T10:00:00Z'))}</button>`).join('')}</div></div>
        <div class="field"><label>${t('time')}</label><div class="pills">${day.slots.map((s) => `<button class="pill" aria-pressed="${p.slot === s.startsAt}" data-a="pick" data-f="slot" data-val="${s.startsAt}" ${s.available ? '' : 'disabled'}>${s.time}</button>`).join('')}</div></div>
        ${btn(t('book'), 'bookReview', p.slot ? '' : 'disabled')}`,
    };
  };
  V.queue = (p) => {
    const q = S.me && S.me.queue;
    if (q) {
      return {
        title: t('sQueue'),
        body: `<div class="card" style="justify-items:center;text-align:center;padding:22px"><small style="color:var(--muted)">${esc(q.office)}</small><b class="mono" style="font-size:44px;line-height:1">${esc(q.label)}</b><span>${esc(q.service)}</span>
          ${q.status === 'called' ? `<span class="chip good">${esc(t('nextUp', { c: q.counter }))}</span>` : `<span class="chip">${esc(t('ahead', { n: q.ahead }))}</span>`}</div>
          <p class="say">${ic('bell', 16)} ${t('ticketNote')}</p>${q.status === 'waiting' ? btn(t('leaveQ'), 'leaveQ', '', 'ghost') : ''}`,
      };
    }
    const ok = onceLoad(p, 'offices', () => api('GET', '/v1/queue/offices'));
    if (!ok) return { title: t('sQueue'), body: loading() };
    p.o = p.o || p.offices[0].id;
    const o = p.offices.find((x) => x.id === p.o);
    if (!o.services.includes(p.s)) p.s = o.services[0];
    return {
      title: t('sQueue'),
      body: `<h3 class="sec">${t('qOffice')}</h3><div style="display:grid;gap:8px">${p.offices.map((x) => `<button class="opt" aria-pressed="${p.o === x.id}" data-a="pick" data-f="o" data-val="${x.id}"><span class="main"><b>${esc(x.name)}</b><small>${esc(t('ahead', { n: x.waiting }))}</small></span></button>`).join('')}</div>
        <h3 class="sec">${t('qService')}</h3><div class="pills">${o.services.map((s) => `<button class="pill" aria-pressed="${p.s === s}" data-a="pick" data-f="s" data-val="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        ${btn(`${ic('ticket', 18)} ${t('getTicket')}`, 'queueReview')}`,
    };
  };
  V.tracker = (p) => {
    const a = S.me && S.me.applications.find((x) => x.id === p.id); if (!a) return { title: t('track'), body: loading() };
    return {
      title: a.title,
      body: `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b class="mono">${esc(a.ref)}</b>${a.status === 'completed' ? `<span class="chip good">${t('completed')}</span>` : a.status === 'rejected' ? `<span class="chip crit">${t('rejected')}</span>` : `<span class="chip">${t('inProgress')}</span>`}</div><small style="color:var(--muted)">${esc(a.agency)} · ${fd(a.createdAt)}</small></div>
        <div class="steps">${a.steps.map((s, i) => `<div class="step ${i <= a.step && a.status !== 'rejected' ? 'done' : ''} ${i === a.step + 1 && a.status === 'open' ? 'now' : ''}"><span class="dot">${i <= a.step && a.status !== 'rejected' ? ic('check', 14) : ''}</span><div><b>${esc(stepLabel(s))}</b></div></div>`).join('')}</div>
        ${a.status === 'completed' ? `<button class="btn" data-a="tab" data-v="vault">${ic('vault', 18)} ${t('vault')}</button>` : ''}`,
    };
  };

  V.notifs = () => {
    const m = S.me; if (!m) return { title: t('notifs'), body: loading() };
    if (m.unread) { api('POST', '/v1/me/notifications/read').then(() => { m.unread = 0; m.notifications.forEach((n) => (n.read_at = n.read_at || new Date().toISOString())); }).catch(() => {}); }
    return { title: t('notifs'), body: m.notifications.length ? `<div class="list">${m.notifications.map((n) => `<div class="row">${ic('bell', 20, 'lead')}<span class="main"><b>${esc(n.title)}${n.read_at ? '' : ' •'}</b><small>${esc(n.body)} · ${esc(ago(n.created_at))}</small></span></div>`).join('')}</div>` : `<p class="hint">${t('notifEmpty')}</p>` };
  };

  V.settings = () => ({
    title: t('settings'),
    body: `<div class="list">
      ${PK().languages.length > 1 ? `<div class="row">${ic('lang', 20, 'lead')}<span class="main"><b>${t('lang')}</b></span><span class="seg">${langPills('')}</span></div>` : ''}
      <button class="row" data-a="go" data-v="connected">${ic('shield', 20, 'lead')}<span class="main"><b>${t('connected')}</b><small>${S.me && S.me.connected ? S.me.connected.length : 0}</small></span>${ic('chev', 16)}</button>
      <div class="row">${ic('id', 20, 'lead')}<span class="main"><b>${esc(PK().name)}</b><small>${esc(PK().currency.code)} · ${esc(PK().languages.map((l) => l.name).join(', '))}${PK().plannedLanguages.length ? ` · ${S.lang === 'tn' ? 'e tla' : 'coming'}: ${esc(PK().plannedLanguages.join(', '))}` : ''}</small></span></div>
      <button class="toggle" role="switch" aria-checked="${S.dataSaver}" data-a="toggle" data-k="dataSaver"><span class="main"><b style="font-weight:600;font-size:14px">${t('dataSaver')}</b><small>${t('dataSaverB')}</small></span><span class="sw"></span></button>
      ${'speechSynthesis' in window ? `<button class="toggle" role="switch" aria-checked="${S.readAloud}" data-a="toggle" data-k="readAloud"><span class="main"><b style="font-weight:600;font-size:14px">${t('readAloud')}</b></span><span class="sw"></span></button>` : ''}
      </div>
      <button class="btn ghost" data-a="signOut">${ic('out', 18)} ${t('signOut')}</button>
      <p class="hint">${t('ussdHint')}</p>`,
  });

  V.connected = () => {
    const m = S.me; if (!m) return { title: t('connected'), body: loading() };
    const list = m.connected || [];
    return {
      title: t('connected'),
      body: `<p class="hint">${t('connectedB')}</p>${list.length ? list.map((c) => `<div class="card">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b>${esc(c.partner.name)}</b><span class="chip good">${ic('check', 11)} ${esc(c.partner.typeLabel)}</span></div>
          <ul class="scopes">${c.scopes.map((x) => `<li>${ic('check', 14)}<span>${esc(x.description)}</span></li>`).join('')}</ul>
          <p style="font-size:12.5px;color:var(--muted)">${esc(c.purpose)} · ${esc(t('until', { d: fd(c.expiresAt) }))}</p>
          <button class="btn sm ghost" data-a="consentRevoke" data-id="${c.id}">${t('withdraw')}</button></div>`).join('') : `<p class="hint">${t('noConnected')}</p>`}`,
    };
  };

  // ---- assistant
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  V.assist = () => {
    const live = S.cfg && S.cfg.assistant === 'claude';
    const intro = { role: 'assistant', content: t('assistIntro', { n: S.me ? S.me.profile.firstName : '' }) };
    const msgs = [intro].concat(S.chat);
    return {
      title: t('assist'),
      chat: true,
      body: `<div class="chat"><span class="ai-chip ${live ? 'live' : ''}"><i></i>${live ? t('liveMode') : t('basicMode')}</span>
        ${msgs.map((m, i) => `<div class="msg ${m.role === 'user' ? 'me' : 'bot'}">${m.content.split('\n').filter((l) => l.trim()).map((l) => `<p>${esc(l)}</p>`).join('')}
          ${m.actions && m.actions.length ? `<div class="acts">${m.actions.map((a, j) => `<button class="primary" data-a="chatAction" data-i="${i - 1}" data-j="${j}">${esc(a.label)}</button>`).join('')}</div>` : ''}</div>`).join('')}
        ${UI.typing ? `<div class="msg bot"><div class="typing"><i></i><i></i><i></i></div></div>` : ''}</div>`,
    };
  };
  /** Suggestion chips; the money example uses this cell's currency and a demo contact when there is one. */
  const sug = (k) => {
    if (k !== 'sug2') return t(k);
    const p = PK(); const friend = p.demo && p.demo.friend; const amt = (p.chips.send[2] || 200);
    return friend ? t('sug2', { amt, friend }) : t('sug2b');
  };
  async function userSay(text) {
    text = String(text || '').trim();
    if (!text || UI.typing) return;
    S.chat.push({ role: 'user', content: text });
    UI.typing = true; saveChat(); render(); scrollChat();
    try {
      const r = await api('POST', '/v1/assistant', { lang: S.lang, messages: S.chat.slice(-16).map((m) => ({ role: m.role, content: m.content })) });
      S.chat.push({ role: 'assistant', content: r.reply, actions: r.actions });
      if (S.readAloud && 'speechSynthesis' in window) { try { const u = new SpeechSynthesisUtterance(r.reply); u.lang = 'en-ZA'; speechSynthesis.speak(u); } catch (e) {} }
    } catch (e) {
      S.chat.push({ role: 'assistant', content: e.message || t('somethingWrong') });
    }
    UI.typing = false; saveChat(); render(); scrollChat();
  }
  const saveChat = () => { try { sessionStorage.setItem('kg.chat', JSON.stringify(S.chat.slice(-30))); } catch (e) {} };
  const scrollChat = () => { const v = document.querySelector('.view'); if (v) v.scrollTop = v.scrollHeight; };
  function listen() {
    if (!SR || UI.listening) return;
    const r = new SR();
    r.lang = 'en-ZA'; // Setswana speech recognition is not available in browsers yet.
    r.interimResults = false;
    UI.listening = true; render();
    r.onresult = (e) => { UI.listening = false; userSay(e.results[0][0].transcript); };
    r.onerror = r.onend = () => { if (UI.listening) { UI.listening = false; render(); } };
    try { r.start(); } catch (e) { UI.listening = false; render(); }
  }

  // ------------------------------------------------------------------ render
  const scr = document.getElementById('screen');
  function render(resetScroll) {
    document.documentElement.lang = S.lang;
    const r = cur();
    const view = V[r.v] || V.home;
    const out = view(r.p || (r.p = {}));
    const prevScroll = (scr.querySelector('.view') || {}).scrollTop || 0;
    const chatVal = (document.getElementById('chatIn') || {}).value || '';
    const focusId = document.activeElement && document.activeElement.id;
    // Keep what the citizen typed across re-renders (busy states, toasts, background refresh).
    const typed = {};
    scr.querySelectorAll('input[id]:not([type=file]),textarea[id]').forEach((el) => { if (el.value) typed[el.id] = el.value; });
    const signedIn = !!S.token;
    let html = '';
    if (out.raw) html = out.raw;
    else {
      const unread = S.me ? S.me.unread : 0;
      const root = S.stack[0] ? S.stack[0].v : 'home';
      html += (S.cfg && S.cfg.demoMode ? `<div class="banner demo">${esc(t('demo'))}</div>` : '') + (S.offline ? `<div class="banner offline">${esc(t('offline'))}</div>` : '');
      html += `<div class="ab">${S.stack.length > 1 ? `<button class="iconbtn" data-a="back" aria-label="${t('back')}">${ic('back', 22)}</button><h2>${esc(out.title || '')}</h2>` : `<span class="logo"><span class="mini-flag" title="${esc(PK().name)}">${flag()}</span>${r.v === 'home' ? 'Kgotla' : esc(out.title || 'Kgotla')}</span>`}
        ${r.v === 'home' ? `<button class="iconbtn" data-a="go" data-v="services" aria-label="${t('services')}">${ic('plus', 22)}</button>` : ''}
        <button class="iconbtn" data-a="go" data-v="notifs" aria-label="${t('notifs')}">${ic('bell', 22)}${unread ? `<span class="badge">${unread}</span>` : ''}</button>
        <button class="iconbtn" data-a="go" data-v="settings" aria-label="${t('settings')}">${ic('gear', 22)}</button></div>
        <div class="view">${out.body}</div>`;
      if (out.chat) {
        html += `<div class="suggest">${['sug1', 'sug2', 'sug3', 'sug4', 'sug5', 'sug6'].map((k) => `<button data-a="assistSay" data-k="${k}">${esc(sug(k))}</button>`).join('')}</div>
          <form class="composer" id="composer">${SR ? `<button type="button" class="iconbtn mic ${UI.listening ? 'on' : ''}" data-a="listen" aria-label="${t('listening')}">${ic('mic', 20)}</button>` : ''}<input id="chatIn" autocomplete="off" placeholder="${UI.listening ? t('listening') : t('talkPrompt')}" aria-label="${t('talkPrompt')}"><button class="iconbtn" type="submit" aria-label="${t('send')}" ${UI.typing ? 'disabled' : ''}>${ic('send', 18)}</button></form>`;
      }
      if (signedIn) html += `<nav class="tabs">${TABS.map((k) => `<button data-a="tab" data-v="${k}" class="${k === 'assist' ? 'mic-tab' : ''}" ${root === k ? 'aria-current="page"' : ''}>${ic(k === 'pay' ? 'wallet' : k === 'assist' ? 'mic' : k, 22)}${t(k)}</button>`).join('')}</nav>`;
    }
    if (UI.sheet) {
      const s = UI.sheet;
      html += `<div class="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="${t('pinT')}">
        ${s.readback ? readbackHtml(s.readback) : ''}
        <h4>${s.busy ? t('verifying') : t('pinT')}</h4><div class="pindots">${[0, 1, 2, 3].map((i) => `<i class="${s.entered.length > i ? 'on' : ''}"></i>`).join('')}</div>
        ${s.error ? `<p class="err center">${esc(s.error)}</p>` : ''}
        <div class="pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, '⌫'].map((k) => (k === '' ? '<span></span>' : `<button data-a="pinKey" data-val="${k}">${k}</button>`)).join('')}</div>
        <button class="btn ghost" data-a="pinCancel">${t('cancel')}</button></div></div>`;
    }
    if (UI.toast) html += `<div class="toast" role="status">${ic('help', 18)} ${esc(UI.toast)}</div>`;
    scr.innerHTML = html;
    const v = scr.querySelector('.view'); if (v) v.scrollTop = resetScroll ? 0 : prevScroll;
    const ci = document.getElementById('chatIn'); if (ci) ci.value = chatVal;
    if (!resetScroll) Object.keys(typed).forEach((id) => { const el = document.getElementById(id); if (el && !el.value) el.value = typed[id]; });
    if (focusId && !resetScroll) { const f = document.getElementById(focusId); if (f && f.focus) f.focus(); }
    if (r.v === 'enrol' && r.p.step === 'face' && r.p.camOn && !r.p.shot) attachCamera(r.p);
  }

  // ------------------------------------------------------------------ camera (enrolment selfie)
  let stream = null;
  async function attachCamera(p) {
    const video = document.getElementById('video'); if (!video) return;
    try {
      if (!stream) stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false });
      video.srcObject = stream;
    } catch (e) { p.camOn = false; p.error = S.lang === 'tn' ? 'Khamera ga e a bulega. Tlhopha setshwantsho.' : 'The camera could not open. Choose a photo instead.'; render(); }
  }
  function stopCamera() { if (stream) { stream.getTracks().forEach((tr) => tr.stop()); stream = null; } }
  async function sendSelfie(p, dataUrl) {
    p.shot = dataUrl; p.error = ''; stopCamera(); UI.busy = true; render();
    try {
      const r = await api('POST', `/v1/enrol/${p.enrolmentId}/liveness`, { selfie: dataUrl });
      p.faceOk = r.passed;
      if (!r.passed) { p.error = t('faceFail'); p.shot = null; p.camOn = false; }
    } catch (e) { p.error = e.message; p.shot = null; p.camOn = false; }
    UI.busy = false; render();
  }

  // ------------------------------------------------------------------ actions
  const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  const keepForm = (p) => { const a = document.getElementById('amt'); if (a) p.amt = a.value; const b = document.getElementById('bref'); if (b) p.ref = b.value; const n = document.getElementById('toNum'); if (n && n.value.trim()) p.to = n.value.trim(); const o = document.getElementById('omang'); if (o) p.omang = o.value; };
  const A = {
    go: (d) => { const p = {}; if (d.k) p.k = d.k; if (d.id) p.id = d.id; go(d.v, p); },
    tab: (d) => tab(d.v),
    back: () => { stopCamera(); back(); },
    lang: async (d) => { S.lang = d.val; store.set('kg.lang', S.lang); render(); if (S.token) api('PATCH', '/v1/me', { lang: S.lang }).catch(() => {}); },
    toggle: (d) => { S[d.k] = !S[d.k]; store.set(d.k === 'dataSaver' ? 'kg.saver' : 'kg.read', S[d.k] ? '1' : '0'); render(); },
    signOut: async () => { try { await api('POST', '/v1/auth/logout'); } catch (e) {} signOutLocal(); },
    pick: (d) => { const p = cur().p; keepForm(p); p[d.f] = d.val; if (d.reset) delete p[d.reset]; render(); },
    setAmt: (d) => { const el = document.getElementById('amt'); if (el) el.value = d.val; cur().p.amt = d.val; },

    // sign in
    loginKey: async (d) => {
      const p = cur().p; keepForm(p); p.error = '';
      if (d.val === '⌫') p.pin = p.pin.slice(0, -1); else if (p.pin.length < 4) p.pin += d.val;
      render();
      if (p.pin.length === 4) {
        try {
          const r = await api('POST', '/v1/auth/login', { nationalId: p.omang || '', pin: p.pin, deviceLabel: navigator.userAgent.slice(0, 60) });
          S.token = r.token; store.set('kg.token', r.token);
          S.stack = [{ v: 'home', p: {} }];
          await refresh();
        } catch (e) { p.pin = ''; p.error = e.message; render(); }
      }
    },

    // enrolment
    enrolStart: async () => {
      const p = cur().p; keepForm(p); UI.busy = true; render();
      try { const r = await api('POST', '/v1/enrol/start', { nationalId: p.omang }); Object.assign(p, r, { step: 'otp', error: '' }); }
      catch (e) { p.error = e.message; }
      UI.busy = false; render(true);
    },
    enrolOtp: async () => {
      const p = cur().p; const code = val('otp'); UI.busy = true; render();
      try { const r = await api('POST', `/v1/enrol/${p.enrolmentId}/otp`, { code }); if (r.ok) { p.step = 'face'; p.error = ''; } else p.error = S.lang === 'tn' ? `Khoutu e phoso. Go setse ${r.attemptsLeft}.` : `Wrong code. ${r.attemptsLeft} tries left.`; }
      catch (e) { p.error = e.message; }
      UI.busy = false; render(true);
    },
    enrolCam: () => { const p = cur().p; p.camOn = true; p.error = ''; render(); },
    enrolCapture: () => {
      const p = cur().p; const v = document.getElementById('video'); if (!v || !v.videoWidth) return;
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
      sendSelfie(p, c.toDataURL('image/jpeg', 0.85));
    },
    enrolStep: (d) => { const p = cur().p; p.step = d.val; p.pin = ''; p.first = ''; render(true); },
    enrolPin: async (d) => {
      const p = cur().p; p.error = '';
      if (d.val === '⌫') p.pin = p.pin.slice(0, -1); else if (p.pin.length < 4) p.pin += d.val;
      render();
      if (p.pin.length < 4) return;
      if (!p.first) { p.first = p.pin; p.pin = ''; setTimeout(render, 150); return; }
      if (p.first !== p.pin) { p.error = t('pinMismatch'); p.first = ''; p.pin = ''; render(); return; }
      try {
        const r = await api('POST', `/v1/enrol/${p.enrolmentId}/complete`, { pin: p.pin, lang: S.lang, deviceLabel: navigator.userAgent.slice(0, 60) });
        S.token = r.token; store.set('kg.token', r.token); p.step = 'done'; await refresh();
      } catch (e) { p.error = e.message; p.first = ''; p.pin = ''; render(); }
    },

    // ID sharing
    fieldToggle: (d) => { const p = cur().p; p.fields[d.k] = p.fields[d.k] ? 0 : 1; if (d.k === 'over18' && p.fields.over18) p.fields.dob = 0; if (d.k === 'dob' && p.fields.dob) p.fields.over18 = 0; p.code = null; render(); },
    makeCode: async () => {
      const p = cur().p; const claims = Object.keys(p.fields).filter((k) => p.fields[k]); if (!claims.length) return;
      UI.busy = true; render();
      try { p.code = await api('POST', '/v1/me/disclosures', { claims }); refresh({ render: false }).catch(() => {}); } catch (e) { fail(e); }
      UI.busy = false; render();
    },

    // Vault
    shareDoc: async (d) => { const p = cur().p; UI.busy = true; render(); try { p.share = await api('POST', `/v1/me/documents/${d.id}/share`, { hours: 24 }); await refresh({ render: false }); } catch (e) { fail(e); } UI.busy = false; render(); },
    revokeLink: async (d) => { const p = cur().p; try { await api('DELETE', `/v1/me/shares/${d.id}`); p.share = null; await refresh({ render: false }); toast(t('revoked')); } catch (e) { fail(e); } },
    copyLink: () => {
      const el = document.getElementById('sharelink'); if (!el) return;
      const sel = () => { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); };
      try { navigator.clipboard.writeText(el.textContent).then(() => toast(t('copied')), sel); } catch (e) { sel(); }
    },

    // money forms -> confirmable actions
    sendReview: () => { const p = cur().p; keepForm(p); prepare('send_money', { to: p.to || '', amount: p.amt || '' }); },
    billReview: () => { const p = cur().p; keepForm(p); prepare('pay_bill', { biller: p.biller, ref: p.ref || '', amount: p.amt || '' }); },
    airReview: () => { const p = cur().p; keepForm(p); prepare('buy_airtime', { network: p.net, amount: p.amt || '' }); },
    topReview: () => { const p = cur().p; keepForm(p); prepare('top_up', { source: p.src, amount: p.amt || '' }); },
    licReview: () => { const [locationId, startsAt] = (cur().p.slot || '').split('|'); prepare('licence_renewal', { eyeTest: { locationId, startsAt } }); },
    bookReview: () => { const p = cur().p; prepare('book_appointment', { locationId: p.loc, startsAt: p.slot }); },
    queueReview: () => { const p = cur().p; prepare('queue_ticket', { locationId: p.o, service: p.s }); },
    prep: (d) => prepare(d.k, {}),
    leaveQ: async () => { try { await api('POST', '/v1/me/queue/leave'); await refresh(); } catch (e) { fail(e); } },
    confirmAction: () => confirmAction(cur().p.action),
    cancelAction: async () => { const a = cur().p.action; try { await api('POST', `/v1/actions/${a.id}/cancel`); } catch (e) {} back(); },

    // partner requests
    consentApprove: (d) => {
      const c = (S.me.consentRequests || []).find((x) => x.id === d.id); if (!c) return;
      askPin([[t('org'), c.partner.name], [t('canDo'), c.scopes.map((x) => x.description).join(' · ')], [t('purpose'), c.purpose]], async (pin) => {
        await api('POST', `/v1/me/consents/${c.id}/approve`, { pin });
        UI.sheet = null; await refresh({ render: false }); toast(t('approvedT'));
      });
    },
    consentDecline: async (d) => { try { await api('POST', `/v1/me/consents/${d.id}/decline`); await refresh({ render: false }); toast(t('declinedT')); } catch (e) { fail(e); } },
    consentRevoke: async (d) => { try { await api('POST', `/v1/me/consents/${d.id}/revoke`); await refresh({ render: false }); toast(t('withdrawn')); } catch (e) { fail(e); } },
    billPay: (d) => prepare('pay_request', { requestId: d.id }),
    billDecline: async (d) => { try { await api('POST', `/v1/me/payment-requests/${d.id}/decline`); await refresh({ render: false }); toast(t('declinedT')); } catch (e) { fail(e); } },

    // PIN sheet
    pinKey: async (d) => {
      const s = UI.sheet; if (!s || s.busy) return;
      s.error = '';
      if (d.val === '⌫') s.entered = s.entered.slice(0, -1); else if (s.entered.length < 4) s.entered += d.val;
      if (s.entered.length < 4) return render();
      s.busy = true; render();
      try { await s.onPin(s.entered); }
      catch (e) {
        if (!UI.sheet) return;
        if (e.code === 'wrong_pin') { s.entered = ''; s.busy = false; s.error = e.message; render(); }
        else { UI.sheet = null; fail(e); }
      }
    },
    pinCancel: () => { UI.sheet = null; render(); },

    // assistant
    assistSay: (d) => { if (S.stack[0].v !== 'assist' || S.stack.length > 1) tab('assist'); userSay(sug(d.k)); },
    listen,
    chatAction: async (d) => {
      const m = S.chat[Number(d.i)]; const a = m && m.actions && m.actions[Number(d.j)]; if (!a) return;
      try { const fresh = await api('GET', `/v1/actions/${a.id}`); if (fresh.status !== 'pending') { toast(fresh.status === 'done' ? (S.lang === 'tn' ? 'Go setse go dirilwe.' : 'Already done.') : (S.lang === 'tn' ? 'Ga e sa dira. Botsa gape.' : 'This has expired. Ask again.')); return; } go('review', { action: fresh }); }
      catch (e) { fail(e); }
    },
  };

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const fn = A[el.dataset.a];
    if (fn) { e.preventDefault(); fn(el.dataset, el); }
  });
  document.addEventListener('submit', (e) => {
    if (e.target.id === 'composer') { e.preventDefault(); const i = document.getElementById('chatIn'); const v = i.value; i.value = ''; userSay(v); }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'selfieFile' && e.target.files && e.target.files[0]) {
      const f = e.target.files[0]; const rd = new FileReader();
      rd.onload = () => {
        // Downscale before upload to save data.
        const img = new Image();
        img.onload = () => { const k = Math.min(1, 800 / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = img.width * k; c.height = img.height * k; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); sendSelfie(cur().p, c.toDataURL('image/jpeg', 0.85)); };
        img.src = rd.result;
      };
      rd.readAsDataURL(f);
    }
  });

  // ------------------------------------------------------------------ timers
  setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach((el) => {
      const left = Math.max(0, Math.ceil((Number(el.dataset.countdown) - Date.now()) / 1000));
      el.textContent = left > 0 ? t('expiresIn', { s: left }) : t('expired');
      if (left === 0 && !el.dataset.done) { el.dataset.done = '1'; render(); }
    });
  }, 1000);
  // Passive views refresh in the background (queue position, application steps).
  const PASSIVE = ['home', 'queue', 'tracker', 'vault', 'pay', 'id', 'notifs'];
  setInterval(() => {
    if (!S.token || document.visibilityState !== 'visible' || UI.sheet || UI.busy) return;
    if (S.dataSaver && Math.random() < 0.66) return;
    refresh({ render: PASSIVE.includes(cur().v) }).catch(() => {});
  }, 15000);
  window.addEventListener('online', () => { S.offline = false; refresh().catch(() => {}); });
  window.addEventListener('offline', () => { S.offline = true; render(); });

  // ------------------------------------------------------------------ boot
  (async function boot() {
    try { S.cfg = await api('GET', '/v1/config'); store.set('kg.cfg', JSON.stringify(S.cfg)); } catch (e) { S.cfg = S.cfg || { demoMode: false, assistant: 'rules' }; }
    if (!PK().languages.some((l) => l.code === S.lang)) { S.lang = PK().languages[0].code; store.set('kg.lang', S.lang); }
    document.title = `Kgotla · ${PK().name}`;
    S.stack = [{ v: S.token ? 'home' : 'welcome', p: {} }];
    render(true);
    if (S.token) refresh().catch(() => {});
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  })();
})();
