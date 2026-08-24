const FAKE_SCENE = `
export const scene = {
  add: () => {}, remove: () => {}, userData: {},
  fog: { color: { set: () => {} } }, background: { set: () => {} },
};
export const sun = { intensity: 1 };
export const hemi = { intensity: 1 };
export const fill = { intensity: 1 };
export const camera = { aspect: 1, updateProjectionMatrix: () => {} };
export const renderer = { domElement: {}, setPixelRatio: () => {}, setSize: () => {} };
export const container = {};
`;
const FAKE_TEXTURES = `const t = () => ({ repeat: { set: () => {} }, dispose: () => {}, colorSpace: 0 });
export const woodTexture = t;
export const checkerTexture = t;
export const curbTexture = t;
`;

export async function resolve(specifier, context, next) {
  const r = await next(specifier, context);
  if (r.url.endsWith('/scene.js')) {
    return { ...r, shortCircuit: true, url: 'fake:scene.js' };
  }
  if (r.url.endsWith('/textures.js')) {
    return { ...r, shortCircuit: true, url: 'fake:textures.js' };
  }
  return r;
}

export async function load(url, context, next) {
  if (url === 'fake:scene.js') {
    return { format: 'module', shortCircuit: true, source: FAKE_SCENE };
  }
  if (url === 'fake:textures.js') {
    return { format: 'module', shortCircuit: true, source: FAKE_TEXTURES };
  }
  return next(url, context);
}
