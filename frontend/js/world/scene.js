/**
 * Assembles the whole room: generates every texture, builds the geometry,
 * registers the lights and wires up the things that change at run time.
 */

import { createCubeTexture } from '../core/gl.js';
import { planeGeometry } from '../core/geometry.js';
import { m4trs } from '../core/math.js';
import {
  artTexture, contactShadow, fabricTexture, marbleTexture, plasterTexture,
  radialGlow, rattanTexture, rugTexture, skyCubeFaces, woodTexture,
} from '../core/textures.js';
import { SceneBuilder } from './builder.js';
import { buildFurniture } from './furniture.js';
import { buildProps } from './props.js';
import { ROOM, WINDOW } from './layout.js';
import { createMaterials } from './materials.js';
import { buildShell } from './room.js';
import { createSkyPanel } from './sky.js';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function generateTextures(onProgress) {
  const tex = {};

  onProgress('laying the floor…');
  await nextFrame();
  tex.floor = woodTexture({
    size: 512, planks: 3, base: '#a9793f', dark: '#5b3a1e', light: '#c99a5e',
    grain: 1.0, roughness: 0.5, roughVariation: 0.26, seed: 11,
  });

  onProgress('oiling the walnut…');
  await nextFrame();
  tex.walnut = woodTexture({
    size: 512, planks: 2, base: '#5c3a24', dark: '#2e1b10', light: '#7d5233',
    grain: 0.85, roughness: 0.38, roughVariation: 0.18, seed: 29,
  });

  onProgress('cutting the oak…');
  await nextFrame();
  tex.oak = woodTexture({
    size: 256, planks: 2, base: '#b08a5c', dark: '#6d4c2c', light: '#cfa877',
    grain: 0.8, roughness: 0.52, roughVariation: 0.2, seed: 53,
  });

  onProgress('plastering the walls…');
  await nextFrame();
  tex.plaster = plasterTexture({ size: 256, base: '#ddd4c6', roughness: 0.92, seed: 7 });

  onProgress('weaving the fabric…');
  await nextFrame();
  tex.weave = fabricTexture({ size: 256, base: '#c9c1b4', weave: 0.55, fuzz: 0.6, roughness: 0.88, seed: 3 });

  onProgress('tying the rug…');
  await nextFrame();
  tex.rug = rugTexture({ size: 512, base: '#5b4a43', accent: '#b0906c' });

  onProgress('hanging the art…');
  await nextFrame();
  tex.art = [
    artTexture(4, ['#26333d', '#c98a4b', '#e9dfd0']),
    artTexture(9, ['#3a2b3f', '#d9a05b', '#efe6d8']),
  ];

  onProgress('polishing the marble…');
  await nextFrame();
  tex.marble = marbleTexture({ size: 256, seed: 21 });

  onProgress('weaving the rattan…');
  await nextFrame();
  tex.rattan = rattanTexture({ size: 256, seed: 9 });

  onProgress('dusting the light…');
  await nextFrame();
  tex.glow = radialGlow(128, 2.6);
  tex.contact = contactShadow(128);

  return tex;
}

/**
 * Turn the generated canvases into real GPU textures. Materials reference these
 * handles directly, so this has to happen before the materials are built.
 */
function uploadTextures(renderer, tex) {
  const tiling = { anisotropy: 8 };
  for (const key of ['floor', 'walnut', 'oak', 'plaster', 'weave', 'marble', 'rattan']) {
    const set = tex[key];
    if (!set) continue;
    for (const kind of ['albedo', 'rough', 'normal']) {
      if (set[kind]) set[kind] = renderer.createTexture(set[kind], tiling);
    }
  }
  if (tex.rug && tex.rug.albedo) tex.rug.albedo = renderer.createTexture(tex.rug.albedo, { clamp: true });
  if (tex.art) tex.art = tex.art.map((canvas) => renderer.createTexture(canvas, { clamp: true }));
  if (tex.glow) tex.glow = renderer.createTexture(tex.glow, { clamp: true, mips: false, minFilter: renderer.gl.LINEAR });
  if (tex.contact) tex.contact = renderer.createTexture(tex.contact, { clamp: true, mips: false, minFilter: renderer.gl.LINEAR });
  return tex;
}

function createLightPool(renderer, materials) {
  const item = renderer.addDynamic(
    planeGeometry(2.5, 1.9),
    { ...materials.lightPool },
    { tag: 'lightPool', castShadow: false, receiveShadow: false }
  );
  item.model = m4trs(
    new Float32Array(16),
    [WINDOW.centerX + 0.25, 0.022, ROOM.minZ + 1.05],
    [1, 1, 1], 0.18, 0, 0
  );
  return item;
}

export async function buildScene(renderer, onProgress = () => {}) {
  const textures = await generateTextures(onProgress);
  onProgress('building the room…');
  await nextFrame();

  uploadTextures(renderer, textures);
  const materials = createMaterials(textures);
  const builder = new SceneBuilder(renderer);

  const shellRefs = buildShell(builder, materials) || {};
  const furnitureRefs = buildFurniture(builder, materials) || {};
  const propsRefs = buildProps(builder, materials, renderer) || {};

  onProgress('opening the curtains…');
  await nextFrame();
  const skyPanel = createSkyPanel(renderer, materials);
  const lightPool = createLightPool(renderer, materials);

  onProgress('uploading geometry…');
  await nextFrame();
  builder.finalize();

  const refs = {
    ...shellRefs,
    ...furnitureRefs,
    ...propsRefs,
    skyPanel,
    lightPool,
    pendantPosition: shellRefs.position || [-0.86, 1.94, 0.62],
    ceilingPosition: [0.55, ROOM.height - 0.08, 0.1],
    windowPosition: [WINDOW.centerX, WINDOW.sill + WINDOW.height * 0.5, ROOM.minZ + 0.25],
  };

  const envState = { texture: null, timeOfDay: 'DAY' };

  function setTimeOfDay(name, rendererInstance = renderer) {
    const faces = skyCubeFaces(name, 96);
    const next = createCubeTexture(rendererInstance.gl, faces, 96);
    if (envState.texture) rendererInstance.gl.deleteTexture(envState.texture);
    envState.texture = next;
    envState.timeOfDay = name;
    rendererInstance.env.texture = next;
    rendererInstance.env.maxLod = 5;
    skyPanel.set(name);
    return next;
  }

  onProgress('letting the light in…');
  await nextFrame();
  setTimeOfDay('DAY');

  return {
    materials,
    textures,
    refs,
    setTimeOfDay,
    envState,
    stats: {
      triangles: builder.triangles,
      drawCalls: renderer.items.length + renderer.transparent.length,
    },
  };
}
