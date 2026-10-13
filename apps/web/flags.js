/* Simplified national flags for the Kgotla country cells, drawn as small inline SVGs,
   plus the colour bands used on the digital ID card. Pages call kgotlaFlag(code). */
(function () {
  'use strict';
  const svg = (inner, w = 600, h = 400) => `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" preserveAspectRatio="xMidYMid slice">${inner}</svg>`;
  const FLAGS = {
    BW: svg('<rect width="36" height="24" fill="#75AADB"/><rect y="9" width="36" height="6" fill="#FFFFFF"/><rect y="10" width="36" height="4" fill="#000000"/>', 36, 24),
    ZA: svg(
      '<rect width="600" height="400" fill="#002395"/><rect width="600" height="200" fill="#DE3831"/>' +
        '<path d="M0 0 L300 200 L0 400 M300 200 H600" fill="none" stroke="#FFFFFF" stroke-width="133"/>' +
        '<path d="M0 0 L300 200 L0 400 M300 200 H600" fill="none" stroke="#007A4D" stroke-width="80"/>' +
        '<path d="M0 48 L228 200 L0 352 Z" fill="#FFB612"/><path d="M0 78 L183 200 L0 322 Z" fill="#000000"/>',
    ),
    NA: svg(
      '<rect width="600" height="400" fill="#009543"/><path d="M0 0 H600 L0 400 Z" fill="#003580"/>' +
        '<path d="M0 400 L600 0" stroke="#FFFFFF" stroke-width="150"/><path d="M0 400 L600 0" stroke="#D21034" stroke-width="105"/>' +
        '<circle cx="110" cy="100" r="46" fill="#FFCE00"/>',
    ),
    ZM: svg(
      '<rect width="600" height="400" fill="#198A00"/>' +
        '<rect x="420" y="160" width="60" height="240" fill="#DE2010"/><rect x="480" y="160" width="60" height="240" fill="#000000"/><rect x="540" y="160" width="60" height="240" fill="#EF7D00"/>' +
        '<path d="M440 95 Q510 40 580 95 Q510 75 440 95 Z" fill="#EF7D00"/><ellipse cx="510" cy="110" rx="14" ry="22" fill="#EF7D00"/>',
    ),
    ZW: svg(
      ['#006400', '#FFD200', '#D40000', '#000000', '#D40000', '#FFD200', '#006400'].map((c, i) => `<rect y="${(i * 400) / 7}" width="600" height="${400 / 7 + 1}" fill="${c}"/>`).join('') +
        '<path d="M0 0 L340 200 L0 400 Z" fill="#FFFFFF" stroke="#000000" stroke-width="14"/>' +
        '<path d="M110 145 L124 188 L169 188 L133 214 L147 257 L110 231 L73 257 L87 214 L51 188 L96 188 Z" fill="#D40000"/>',
    ),
  };
  // Colour bands for the ID card stripe: [colour, relative height].
  const BANDS = {
    BW: [['#75AADB', 9], ['#FFFFFF', 1], ['#000000', 4], ['#FFFFFF', 1], ['#75AADB', 9]],
    ZA: [['#007A4D', 3], ['#FFB612', 1], ['#000000', 2], ['#FFFFFF', 1], ['#DE3831', 3], ['#002395', 3]],
    NA: [['#003580', 4], ['#FFFFFF', 1], ['#D21034', 3], ['#FFFFFF', 1], ['#009543', 4]],
    ZM: [['#198A00', 6], ['#DE2010', 1], ['#000000', 1], ['#EF7D00', 1]],
    ZW: [['#006400', 1], ['#FFD200', 1], ['#D40000', 1], ['#000000', 1], ['#D40000', 1], ['#FFD200', 1], ['#006400', 1]],
  };
  window.kgotlaFlag = (code) => FLAGS[code] || FLAGS.BW;
  /** CSS background for a thin horizontal stripe in the country's colours. */
  window.kgotlaBands = (code) => {
    const b = BANDS[code] || BANDS.BW;
    const total = b.reduce((s, x) => s + x[1], 0);
    let at = 0;
    const stops = b.map(([c, w]) => { const from = (at / total) * 100; at += w; return `${c} ${from}% ${(at / total) * 100}%`; });
    return `linear-gradient(to bottom, ${stops.join(', ')})`;
  };
  // Staff pages: fill <span data-flag> once the cell's country is known.
  document.addEventListener('DOMContentLoaded', () => {
    const spots = document.querySelectorAll('[data-flag]');
    if (!spots.length) return;
    fetch('/v1/config').then((r) => r.json()).then((c) => {
      spots.forEach((el) => { el.innerHTML = window.kgotlaFlag(c.country); el.title = (c.pack && c.pack.name) || ''; });
    }).catch(() => spots.forEach((el) => { el.innerHTML = window.kgotlaFlag('BW'); }));
  });
})();
