// nametag.js — 3D name tags floating above the karts. In WS 2P the other
// player's nickname is shown above their kart (so you can tell whose kart is
// whose) and "YOU" above yours; AI karts show AI-3/AI-4. In solo the labels
// are hidden (no opponent to identify).
//
// Canvas-sprite (the blastfx.js pattern): a rounded pill + the text,
// billboarded (always faces the camera), repositioned in world space above the
// kart each frame. The texture is only redrawn when the label changes.
import * as THREE from 'three';

const N = 4; // wire slots 0..3 (0=host, 1=joiner, 2/3=AI)

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function makeNameTags(getRacers, labelOf) {
  const tags = [];
  for (let i = 0; i < N; i++) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 72;
    const ctx = cv.getContext('2d');
    const tex = new THREE.CanvasTexture(cv);
    const mat = new THREE.SpriteMaterial({
      map: tex, depthWrite: false, transparent: true, opacity: 0.9,
    });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(1.9, 0.53, 1);
    let last = null;
    const setText = (t) => {
      if (t === last) return;   // only redraw on a real change
      last = t;
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = 'rgba(12,14,18,0.55)';
      roundRect(ctx, 10, 10, cv.width - 20, cv.height - 20, 22);
      ctx.fill();
      ctx.fillStyle = '#eef2f8';
      ctx.font = 'bold 36px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, cv.width / 2, cv.height / 2 + 2);
      tex.needsUpdate = true;
    };
    tags.push({ spr, setText });
  }
  return {
    addAll(scene) { for (const t of tags) scene.add(t.spr); },
    tags,   // for e2e inspection (visibility)
    update() {
      const list = getRacers();
      for (let i = 0; i < N; i++) {
        const k = list[i];
        const label = labelOf(i);
        const show = !!k && !!label && k.mesh.root.visible;
        tags[i].spr.visible = show;
        if (!show) continue;
        tags[i].spr.position.set(k.pos.x, k.pos.y + 1.5, k.pos.z);
        tags[i].setText(label);
      }
    },
  };
}
