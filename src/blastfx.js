import * as THREE from 'three';
import { KMH_PER_U, BLAST_KMH } from './config.js';

/* ------------------------------------------------------------------ *
 *  Exhaust blast FX — flame + smoke sprayed from the rear exhaust tips
 *  when the kart is above BLAST_KMH. Parented to the kart root so it
 *  inherits heading + position; particles trail backwards (-z).
 *
 *  Headless-safe: fxTexture() returns null without a DOM, and the
 *  pools just animate invisible sprites (ai-sim never sees them).
 * ------------------------------------------------------------------ */

/**
 * One soft circular glow, shared by every kart's exhaust FX (cheap + no
 * re-upload). Additive for flame, normal blend for smoke.
 */
let _fxTex = null;
function fxTexture() {
  if (_fxTex) return _fxTex;
  if (typeof document === 'undefined') return null;   // headless (ai-sim): FX is visual-only
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0.0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.4, 'rgba(255,255,255,0.75)');
  gr.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  _fxTex = new THREE.CanvasTexture(c);
  return _fxTex;
}

/**
 * Build the blast for one kart.
 * @param parent  the kart root group (local-space tips hang off it)
 * @param tips    two local-space exhaust mouth positions
 * @returns {update(dt, speed)} — call once per frame with the kart's speed.
 */
export function makeBlastFx(parent, tips) {
  const tex = fxTexture();
  const fx = new THREE.Group();
  parent.add(fx);
  const makePool = (n, kind) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: kind === 'fire' ? 0xff5a1e : 0x9a9aa2,
        transparent: true,
        depthWrite: false,
        blending: kind === 'fire' ? THREE.AdditiveBlending : THREE.NormalBlending,
        opacity: 0,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.renderOrder = kind === 'fire' ? 3 : 2;    // fire draws over the bright track
      fx.add(sprite);
      arr.push({ s: sprite, kind, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, base: 1, life: 0, ttl: 1 });
    }
    return arr;
  };
  const fire = makePool(10, 'fire');
  const smoke = makePool(6, 'smoke');
  let fireT = 0, smokeT = 0;

  return {
    update(dt, speed) {
      const over = Math.abs(speed) * KMH_PER_U > BLAST_KMH
        ? Math.min((Math.abs(speed) * KMH_PER_U - BLAST_KMH) / 30, 1) : 0; // 0..1, hottest at the top end
      // emission only above the threshold
      if (over > 0) {
        fireT -= dt;
        while (fireT <= 0) {
          const t = tips[(Math.random() * 2) | 0];
          const slot = fire[(Math.random() * fire.length) | 0];
          slot.x = t.x; slot.y = t.y - 0.05; slot.z = t.z;
          slot.vx = (Math.random() - 0.5) * 0.25;
          slot.vy = 0.1 + Math.random() * 0.2;
          slot.vz = -(4.0 + over * 6.0) - Math.random() * 1.5;    // shoot backward (-z)
          slot.base = 0.14 + over * 0.22 + Math.random() * 0.06;
          slot.ttl = 0.16 + Math.random() * 0.14; slot.life = slot.ttl;
          slot.s.material.color.setHex(over > 0.55 ? 0xffd24a : 0xff4e10);
          slot.s.visible = true;
          fireT += 0.028 - over * 0.022;                           // faster cadence when hotter
        }
        smokeT -= dt;
        while (smokeT <= 0) {
          const t = tips[(Math.random() * 2) | 0];
          const slot = smoke[(Math.random() * smoke.length) | 0];
          slot.x = t.x; slot.y = t.y; slot.z = t.z - 0.2;
          slot.vx = (Math.random() - 0.5) * 0.3;
          slot.vy = 0.3 + Math.random() * 0.3;
          slot.vz = -(2.0 + over * 2.5);
          slot.base = 0.22 + over * 0.12;
          slot.ttl = 0.7 + Math.random() * 0.5; slot.life = slot.ttl;
          slot.s.visible = true;
          smokeT += 0.09;
        }
      }
      // integrate both pools every frame so they trail + fade after the kart slows
      const fade = Math.exp(-1.0 * dt), slow = Math.exp(-1.4 * dt);
      for (const p of fire) {
        if (p.life <= 0) { if (p.s.visible) p.s.visible = false; continue; }
        p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.vx *= fade; p.vz *= slow;
        const k = Math.max(p.life / p.ttl, 0);
        p.s.position.set(p.x, p.y, p.z);
        p.s.material.opacity = 0.95 * k;
        p.s.scale.setScalar(p.base * (0.35 + 0.65 * k));
        if (p.life <= 0) p.s.visible = false;
      }
      for (const p of smoke) {
        if (p.life <= 0) { if (p.s.visible) p.s.visible = false; continue; }
        p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        p.vy += 0.3 * dt;                  // buoyant rise
        p.vx *= fade; p.vz *= slow;
        const k = Math.max(p.life / p.ttl, 0);
        p.s.position.set(p.x, p.y, p.z);
        p.s.material.opacity = 0.4 * k;
        p.s.scale.setScalar(p.base * (0.6 + (1 - k) * 1.8));
        if (p.life <= 0) p.s.visible = false;
      }
    },
  };
}
