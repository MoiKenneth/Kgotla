(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const LABEL = { name: 'Full name', photo: 'Photo', dob: 'Date of birth', over18: 'Over 18', district: 'Home district', id_last4: 'ID (last 4 digits)', omang_last4: 'ID (last 4 digits)' };

  async function check(code) {
    const r = $('result');
    r.hidden = false;
    r.innerHTML = '<p class="hint">Checking…</p>';
    try {
      const res = await fetch('/v1/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.trim() }) });
      const j = await res.json();
      if (!res.ok) throw j.error || { message: 'Check failed' };
      if (!j.valid) { r.innerHTML = `<h2><span class="chip crit">NOT VALID</span></h2><p>${esc(j.reason)}</p>`; return; }
      r.innerHTML = `<h2><span class="chip good">VALID</span> Kgotla ID · ${esc(j.country || '')} · assurance level ${esc(j.assuranceLevel)}</h2>
        <div class="tbl"><table><tbody>${Object.entries(j.claims).map(([k, v]) => `<tr><th>${esc(LABEL[k] || k)}</th><td>${k === 'over18' ? (v ? '<span class="chip good">YES</span>' : '<span class="chip crit">NO</span>') : k === 'photo' ? 'Shown by the registry photo service' : esc(v)}</td></tr>`).join('')}</tbody></table></div>
        <p class="hint">This code expires ${esc(new Date(j.expiresAt).toLocaleTimeString())}. The citizen chose to share only these details.</p>`;
    } catch (e) { r.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  }

  $('check').addEventListener('click', () => check($('code').value));

  // Camera scanning where the browser can detect QR codes (Chrome on Android, most Chromium browsers).
  if ('BarcodeDetector' in window) {
    $('scan').hidden = false;
    $('scan').addEventListener('click', async () => {
      const v = $('video');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        v.srcObject = stream; v.hidden = false; await v.play();
        const det = new window.BarcodeDetector({ formats: ['qr_code'] });
        const loop = async () => {
          if (v.hidden) return;
          try {
            const codes = await det.detect(v);
            if (codes.length) { stream.getTracks().forEach((tr) => tr.stop()); v.hidden = true; $('code').value = codes[0].rawValue; check(codes[0].rawValue); return; }
          } catch (e) {}
          requestAnimationFrame(loop);
        };
        loop();
      } catch (e) { $('result').hidden = false; $('result').innerHTML = '<p class="err">The camera could not open. Paste the code instead.</p>'; }
    });
  }
})();
