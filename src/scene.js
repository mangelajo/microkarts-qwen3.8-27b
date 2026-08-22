import * as THREE from 'three';
import { addSky } from './sky.js';

/* ------------------------------------------------------------------ *
 *  Renderer / scene / lights
 * ------------------------------------------------------------------ */
export const container = document.getElementById('app');
export const renderer  = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x180f0a);
scene.fog = new THREE.Fog(0x180f0a, 130, 320);

export const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);

scene.add(new THREE.HemisphereLight(0xfff2dd, 0x2a1a10, 0.85));

const sun = new THREE.DirectionalLight(0xfff0d8, 1.6);
sun.position.set(60, 90, -35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -110;
sun.shadow.camera.right = 110;
sun.shadow.camera.top = 110;
sun.shadow.camera.bottom = -110;
sun.shadow.camera.near = 10;
sun.shadow.camera.far = 300;
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
fill.position.set(-40, 30, 50);
scene.add(fill);

// dusk sky dome + sun glow (procedural, see sky.js)
addSky(scene, sun.position.clone());
