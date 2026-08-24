import * as THREE from 'three';

export function woodTexture(base = '#8a5a33') {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y += 64) {
    g.fillStyle = `rgba(30,15,5,${0.25 + Math.random() * 0.15})`;
    g.fillRect(0, y, 512, 3);
    for (let i = 0; i < 7; i++) {
      g.strokeStyle = `rgba(55,28,10,${0.06 + Math.random() * 0.14})`;
      g.lineWidth = 1 + Math.random() * 2;
      const yy = y + 4 + Math.random() * 56;
      g.beginPath();
      g.moveTo(0, yy);
      g.bezierCurveTo(128, yy + Math.random() * 10 - 5, 384, yy + Math.random() * 10 - 5, 512, yy);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(12, 12);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function checkerTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      g.fillStyle = (x + y) % 2 ? '#151515' : '#efefef';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function curbTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 8;
  const g = c.getContext('2d');
  g.fillStyle = '#d93a30'; g.fillRect(0, 0, 32, 8);
  g.fillStyle = '#f4f0ec'; g.fillRect(32, 0, 32, 8);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
