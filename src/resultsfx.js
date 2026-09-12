/* ------------------------------------------------------------------ *
 *  Results juice — the podium pips + confetti burst when a race
 *  finishes (solo, 2P host AND join client all call into here).
 *
 *  Browser-only (DOM + canvas): the ordering data comes in as a plain
 *  array (raceOrder() output — covered headlessly by `make netsim`),
 *  so nothing in here is needed by ai-sim. Zero-asset policy: the
 *  confetti is ~180 animated coloured rects on an overlay canvas.
 * ------------------------------------------------------------------ */

const MEDAL = ['#ffd23f', '#cfd4dc', '#d9915b'];   // gold / silver / bronze

/**
 * The podium block for the results screen: top 3 as medal pips in the
 * classic 2-1-3 layout (1st biggest), the rest as plain numbered pips.
 * @param order  the karts, fastest first (raceOrder output)
 * @param nameOf  k => display name (bolding decided by the caller's rows)
 */
export function podiumHtml(order, nameOf) {
  const slot = (medal) => {
    const k = order[medal];
    if (!k) return '';
    const size = 30 + (3 - medal) * 8;                 // 1st: 46, 2nd: 38, 3rd: 30
    return `<div style="text-align:center">
      <div style="width:${size}px;height:${size}px;border-radius:50%;margin:0 auto;background:${MEDAL[medal]};box-shadow:0 0 16px ${MEDAL[medal]}99;display:flex;align-items:center;justify-content:center;font-size:${11 + (3 - medal) * 3}px;font-weight:bold;color:#221a10">${medal + 1}</div>
      <div style="margin-top:5px;font-size:11px;letter-spacing:1px;white-space:nowrap">${nameOf(k)}</div>
    </div>`;
  };
  let html = '<div style="display:flex;gap:16px;align-items:flex-end;justify-content:center;margin:14px 0 4px">'
    + [1, 0, 2].map(slot).join('');
  for (let i = 3; i < order.length; i++) {
    html += `<div style="text-align:center">
      <div style="width:24px;height:24px;border-radius:50%;margin:0 auto;background:#4a4452;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold;color:#cfc8d8">${i + 1}</div>
      <div style="margin-top:5px;font-size:11px;letter-spacing:1px;white-space:nowrap;opacity:.7">${nameOf(order[i])}</div>
    </div>`;
  }
  return html + '</div>';
}

/* ---------------- confetti burst (~6 s, self-clearing) ---------------- */
let canvas = null;
let running = false;

export function celebrate() {
  if (running) return;                                // already bursting
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:60';
    document.body.appendChild(canvas);
  }
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  const g = canvas.getContext('2d');
  const colors = ['#ffd23f', '#ff5aa8', '#8fd4ff', '#9be36a', '#ff8a3d', '#f4f0e8'];
  const parts = Array.from({ length: 180 }, () => ({
    x: Math.random() * canvas.width,
    y: -20 - Math.random() * canvas.height * 0.6,
    w: 5 + Math.random() * 7,
    h: 8 + Math.random() * 10,
    vx: -1.2 + Math.random() * 2.4,
    vy: 2 + Math.random() * 3.5,
    rot: Math.random() * Math.PI,
    vr: -0.15 + Math.random() * 0.3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  running = true;
  const t0 = performance.now();
  const tick = () => {
    const t = performance.now() - t0;
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.y += p.vy;
      p.x += p.vx + Math.sin(p.y * 0.02) * 0.8;
      p.rot += p.vr;
      g.save();
      g.translate(p.x, p.y);
      g.rotate(p.rot);
      g.fillStyle = p.c;
      g.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      g.restore();
    }
    if (t < 6000) requestAnimationFrame(tick);
    else {
      running = false;
      g.clearRect(0, 0, canvas.width, canvas.height);
    }
  };
  requestAnimationFrame(tick);
}
