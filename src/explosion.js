import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  One-shot explosion FX — a kart that fell off an elevated track and
 *  hits the table: particle burst + smoke + expanding shockwave ring.
 *  Scene-level (not parented to a kart: the kart stays in its crash
 *  pose while the debris flies).
 *
 *  Headless-safe: without a DOM the pool still updates (invisible
 *  geometry), so ai-sim can exercise it.
 * ------------------------------------------------------------------ */

const COLORS = [0xffc23f, 0xff8a3d, 0xff5040, 0xffd9a0];
const SMOKE = [0x9aa0a8, 0x6f767e];
const PER_BOOM = 12;     // particles per explosion
const MAX_BOOMS = 8;     // concurrent explosions

export function makeExplosions(scene) {
  const pool = [];      // live particles
  const rings = [];     // live shockwave rings
  const sphere = new THREE.SphereGeometry(0.22, 8, 6);

  const spawnParticle = (x, y, z, smoke) => {
    const pal = smoke ? SMOKE : COLORS;
    const m = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({
      color: pal[(Math.random() * pal.length) | 0],
      transparent: true,
      opacity: 1,
    }));
    m.position.set(x, y, z);
    const a = Math.random() * Math.PI * 2;
    const v = 3 + Math.random() * 6;
    m.userData = {
      vx: Math.cos(a) * v,
      vy: 3 + Math.random() * 5,
      vz: Math.sin(a) * v,
      t: 0,
      life: 0.9 + Math.random() * 0.5,
      s: 0.6 + Math.random() * 0.9,
      smoke,
    };
    scene.add(m);
    pool.push(m);
  };

  const spawnRing = (x, y, z) => {
    const r = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.07, 8, 28),
      new THREE.MeshBasicMaterial({ color: 0xffe9c4, transparent: true, opacity: 0.85 }));
    r.rotation.x = -Math.PI / 2;
    r.position.set(x, Math.max(0.1, y), z);
    r.userData = { t: 0, life: 0.45 };
    scene.add(r);
    rings.push(r);
  };

  return {
    boom(x, y, z) {
      if (pool.length + rings.length * 4 > PER_BOOM * MAX_BOOMS) return;   // pool saturated
      for (let i = 0; i < PER_BOOM; i++) spawnParticle(x, y + 0.3, z, i >= PER_BOOM - 4);
      spawnRing(x, y, z);
    },
    count: () => pool.length + rings.length,   // live FX objects (bench + debug)
    update(dt) {
      for (let i = pool.length - 1; i >= 0; i--) {
        const p = pool[i], u = p.userData;
        u.t += dt;
        if (u.t >= u.life) {
          scene.remove(p);
          p.material.dispose();
          pool.splice(i, 1);
          continue;
        }
        u.vy -= 9.8 * 0.7 * dt;
        p.position.x += u.vx * dt;
        p.position.y = Math.max(0.05, p.position.y + u.vy * dt);
        p.position.z += u.vz * dt;
        const f = 1 - u.t / u.life;
        p.scale.setScalar(u.s * f);
        p.material.opacity = f;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i], u = r.userData;
        u.t += dt;
        if (u.t >= u.life) {
          scene.remove(r);
          r.material.dispose();
          rings.splice(i, 1);
          continue;
        }
        const f = u.t / u.life;
        r.scale.setScalar(0.6 + f * 6);
        r.material.opacity = 0.85 * (1 - f);
      }
    },
  };
}
