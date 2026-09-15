/**
 * The material library. Every entry is a plain descriptor consumed by the PBR
 * program: base colour, metalness, roughness, optional maps and emission.
 *
 * Colour values are linear-ish sRGB triplets in 0..1; the shader treats them as
 * albedo and the tonemapper brings the whole image back into range.
 */

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export function createMaterials(tex) {
  const M = {};

  /* ---------------------------------------------------------- architecture */
  M.floor = {
    albedo: [1, 1, 1],
    maps: { albedo: tex.floor.albedo, normal: tex.floor.normal, rough: tex.floor.rough },
    roughness: 1.0,
    metallic: 0,
    uvScale: [2.6, 2.0],
    normalScale: 0.9,
    name: 'floor',
  };

  M.wall = {
    albedo: [1, 1, 1],
    maps: { albedo: tex.plaster.albedo, normal: tex.plaster.normal, rough: tex.plaster.rough },
    roughness: 1.0,
    metallic: 0,
    uvScale: [3.2, 1.8],
    normalScale: 0.5,
    name: 'wall',
  };

  M.accentWall = {
    ...M.wall,
    albedo: rgb('#8d8577'),
    uvScale: [3.2, 1.8],
    name: 'accentWall',
  };

  M.ceiling = {
    albedo: rgb('#e9e4dc'),
    roughness: 0.95,
    metallic: 0,
    name: 'ceiling',
  };

  M.rug = {
    albedo: [1, 1, 1],
    maps: { albedo: tex.rug.albedo },
    roughness: 0.96,
    metallic: 0,
    uvScale: [1, 1],
    name: 'rug',
  };

  M.skirting = {
    albedo: rgb('#f2ede5'),
    roughness: 0.62,
    metallic: 0,
    name: 'skirting',
  };

  /* ----------------------------------------------------------------- wood */
  M.walnut = {
    albedo: [1, 1, 1],
    maps: { albedo: tex.walnut.albedo, normal: tex.walnut.normal, rough: tex.walnut.rough },
    roughness: 1.0,
    metallic: 0,
    uvScale: [1, 1],
    normalScale: 0.7,
    name: 'walnut',
  };

  M.oak = {
    albedo: [1, 1, 1],
    maps: { albedo: tex.oak.albedo, normal: tex.oak.normal, rough: tex.oak.rough },
    roughness: 1.0,
    metallic: 0,
    uvScale: [1, 1],
    normalScale: 0.7,
    name: 'oak',
  };

  M.marble = {
    albedo: [1, 1, 1],
    maps: { albedo: tex.marble.albedo, normal: tex.marble.normal, rough: tex.marble.rough },
    roughness: 1.0,
    metallic: 0,
    uvScale: [1, 1],
    normalScale: 0.4,
    name: 'marble',
  };

  M.rattan = {
    albedo: [1, 1, 1],
    maps: { albedo: tex.rattan.albedo, normal: tex.rattan.normal, rough: tex.rattan.rough },
    roughness: 1.0,
    metallic: 0,
    uvScale: [3, 3],
    normalScale: 1.0,
    cull: false,
    name: 'rattan',
  };

  M.cork = { albedo: rgb('#b98d5e'), roughness: 0.85, metallic: 0, name: 'cork' };
  M.jarGlass = {
    albedo: rgb('#dfe9e6'),
    roughness: 0.05,
    metallic: 0,
    opacity: 0.22,
    blend: 'alpha',
    depthWrite: false,
    name: 'jarGlass',
  };
  M.jarHerb = { albedo: rgb('#5a713a'), roughness: 0.9, name: 'jarHerb' };
  M.jarSalt = { albedo: rgb('#e9e4da'), roughness: 0.9, name: 'jarSalt' };
  M.jarBerry = { albedo: rgb('#a33b2e'), roughness: 0.6, name: 'jarBerry' };

  /* --------------------------------------------------------------- fabric */
  const fabric = (colour, roughness = 0.9, scale = 2.2, maps = tex.weave) => ({
    albedo: rgb(colour),
    maps: { albedo: maps.albedo, normal: maps.normal, rough: maps.rough },
    roughness,
    metallic: 0,
    uvScale: [scale, scale],
    normalScale: 0.85,
  });

  M.sofa = { ...fabric('#4c5f58', 0.92, 2.6), name: 'sofa' };
  M.cushion = { ...fabric('#b3763f', 0.9, 3.0), name: 'cushion' };
  M.cushionAlt = { ...fabric('#d9cfc0', 0.9, 3.2), name: 'cushionAlt' };
  M.duvet = { ...fabric('#cfc6b8', 0.95, 2.4), name: 'duvet' };
  M.pillow = { ...fabric('#efe9df', 0.94, 3.4), name: 'pillow' };
  M.blanket = { ...fabric('#7a4a3c', 0.9, 2.8), name: 'blanket' };
  M.chairSeat = { ...fabric('#3b3f45', 0.88, 3.0), name: 'chairSeat' };
  M.curtain = {
    ...fabric('#ddd3c2', 0.96, 1.6),
    translucent: 0.35,
    cull: false,
    name: 'curtain',
  };
  M.lampShade = {
    albedo: rgb('#f6e7cf'),
    roughness: 0.9,
    metallic: 0,
    translucent: 0.85,
    cull: false,
    emissive: rgb('#ffd9a0'),
    emissiveStrength: 0,
    name: 'lampShade',
  };

  /* ---------------------------------------------------------------- metal */
  M.metalBlack = {
    albedo: rgb('#2a2c30'),
    roughness: 0.42,
    metallic: 0.9,
    name: 'metalBlack',
  };
  M.metalBrushed = {
    albedo: rgb('#9aa0a6'),
    roughness: 0.34,
    metallic: 1.0,
    name: 'metalBrushed',
  };
  M.brass = {
    albedo: rgb('#c8a05a'),
    roughness: 0.28,
    metallic: 1.0,
    name: 'brass',
  };

  /* -------------------------------------------------------------- ceramic */
  M.ceramic = {
    albedo: rgb('#e8e2d6'),
    roughness: 0.28,
    metallic: 0,
    name: 'ceramic',
  };
  M.terracotta = {
    albedo: rgb('#a4613f'),
    roughness: 0.72,
    metallic: 0,
    name: 'terracotta',
  };
  M.soil = {
    albedo: rgb('#2e2419'),
    roughness: 0.98,
    metallic: 0,
    name: 'soil',
  };
  M.leaf = {
    albedo: rgb('#3f6b34'),
    roughness: 0.55,
    metallic: 0,
    translucent: 0.5,
    cull: false,
    name: 'leaf',
  };
  M.leafDeep = {
    ...M.leaf,
    albedo: rgb('#2c5230'),
    name: 'leafDeep',
  };

  /* ---------------------------------------------------------------- glass */
  M.glass = {
    albedo: rgb('#cfe2e6'),
    roughness: 0.06,
    metallic: 0,
    opacity: 0.16,
    blend: 'alpha',
    depthWrite: false,
    name: 'glass',
  };
  M.windowGlass = {
    albedo: rgb('#dff0f5'),
    roughness: 0.03,
    metallic: 0,
    opacity: 0.09,
    blend: 'alpha',
    depthWrite: false,
    name: 'windowGlass',
  };

  /* --------------------------------------------------------------- screens */
  M.screenOff = {
    albedo: rgb('#05070a'),
    roughness: 0.12,
    metallic: 0.35,
    emissive: rgb('#7fe4ff'),
    emissiveStrength: 0,
    name: 'screen',
  };

  M.plastic = {
    albedo: rgb('#1b1d21'),
    roughness: 0.55,
    metallic: 0.1,
    name: 'plastic',
  };
  M.rubber = {
    albedo: rgb('#15171a'),
    roughness: 0.85,
    metallic: 0,
    name: 'rubber',
  };

  /* ---------------------------------------------------------------- books */
  M.bookA = { albedo: rgb('#8c3b32'), roughness: 0.78, name: 'bookA' };
  M.bookB = { albedo: rgb('#2f4858'), roughness: 0.78, name: 'bookB' };
  M.bookC = { albedo: rgb('#6d6a4f'), roughness: 0.78, name: 'bookC' };
  M.bookD = { albedo: rgb('#c9b79c'), roughness: 0.78, name: 'bookD' };
  M.bookPages = { albedo: rgb('#e6dfcf'), roughness: 0.9, name: 'bookPages' };

  /* ------------------------------------------------------------------ art */
  M.art = (index) => ({
    albedo: [1, 1, 1],
    maps: { albedo: tex.art[index % tex.art.length] },
    roughness: 0.82,
    metallic: 0,
    uvScale: [1, 1],
    name: 'art',
  });

  /* --------------------------------------------------------------- lights */
  M.bulb = {
    albedo: rgb('#fff3df'),
    roughness: 0.3,
    emissive: rgb('#ffd7a1'),
    emissiveStrength: 6,
    name: 'bulb',
  };

  /* ------------------------------------------------------------ AI entity */
  M.aiShell = {
    albedo: rgb('#f4f5f6'),
    roughness: 0.14,
    metallic: 0.05,
    emissive: rgb('#ffd9ae'),
    emissiveStrength: 0.05,
    name: 'aiShell',
  };
  M.aiFace = {
    albedo: rgb('#05070a'),
    roughness: 0.05,
    metallic: 0.3,
    emissive: rgb('#1a0e05'),
    emissiveStrength: 0.4,
    name: 'aiFace',
  };
  M.aiEye = {
    albedo: rgb('#0a0502'),
    roughness: 0.2,
    emissive: rgb('#ffb066'),
    emissiveStrength: 3.2,
    name: 'aiEye',
  };
  M.aiPupil = {
    albedo: rgb('#02040a'),
    roughness: 0.1,
    emissive: rgb('#0a1b28'),
    emissiveStrength: 0.6,
    name: 'aiPupil',
  };
  M.aiRing = {
    albedo: rgb('#1b2a33'),
    roughness: 0.22,
    metallic: 0.85,
    emissive: rgb('#7fe4ff'),
    emissiveStrength: 0.9,
    name: 'aiRing',
  };
  M.aiCore = {
    albedo: rgb('#0c1116'),
    roughness: 0.1,
    emissive: rgb('#7fe4ff'),
    emissiveStrength: 1.6,
    name: 'aiCore',
  };

  /* --------------------------------------------------------------- decals */
  M.contactShadow = {
    program: 'unlit',
    blend: 'alpha',
    texture: tex.contact,
    color: [0, 0, 0, 0.55],
    depthWrite: false,
    cull: false,
    name: 'contactShadow',
  };
  M.lightPool = {
    program: 'unlit',
    blend: 'additive',
    texture: tex.glow,
    color: [1, 0.86, 0.66, 0.35],
    depthWrite: false,
    cull: false,
    softEdge: true,
    name: 'lightPool',
  };
  M.aura = {
    program: 'unlit',
    blend: 'additive',
    texture: tex.glow,
    color: [0.45, 0.85, 1.0, 0.5],
    depthWrite: false,
    cull: false,
    softEdge: true,
    name: 'aura',
  };

  return M;
}
