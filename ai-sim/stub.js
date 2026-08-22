// Loader-hook entry: point Node's loader at our resolve/load customization
// so src/scene.js (needs WebGL) is replaced by a headless fake.
import { register } from 'node:module';
register(new URL('./hooks.mjs', import.meta.url));
