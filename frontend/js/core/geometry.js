/**
 * Geometry builders. Everything is generated procedurally at start-up, so the
 * application ships without a single binary asset.
 *
 * A mesh is a plain object:
 *   { position: Float32Array(3n), normal: Float32Array(3n),
 *     uv: Float32Array(2n), tangent: Float32Array(4n), index: Uint32Array }
 *
 * All triangles are counter-clockwise when seen from the outside, which is what
 * gl.frontFace(gl.CCW) + back-face culling expects.
 */

import { clamp } from './math.js';

export function createMesh() {
  return { position: [], normal: [], uv: [], tangent: [], index: [] };
}

export function finalizeMesh(mesh) {
  const out = {
    position: new Float32Array(mesh.position),
    normal: new Float32Array(mesh.normal),
    uv: new Float32Array(mesh.uv),
    index: new Uint32Array(mesh.index),
  };
  out.tangent = computeTangents(out);
  out.count = out.index.length;
  out.vertices = out.position.length / 3;
  return out;
}

function pushVertex(mesh, px, py, pz, nx, ny, nz, u, v) {
  mesh.position.push(px, py, pz);
  mesh.normal.push(nx, ny, nz);
  mesh.uv.push(u, v);
  return mesh.position.length / 3 - 1;
}

function pushQuad(mesh, a, b, c, d) {
  mesh.index.push(a, b, c, a, c, d);
}

/** Tangent basis derived from UVs (simplified MikkTSpace). */
export function computeTangents(mesh) {
  const count = mesh.position.length / 3;
  const tan = new Float32Array(count * 4);
  const { position: pos, normal: nor, uv, index } = mesh;
  for (let i = 0; i < index.length; i += 3) {
    const i1 = index[i], i2 = index[i + 1], i3 = index[i + 2];
    const x1 = pos[i2 * 3] - pos[i1 * 3];
    const y1 = pos[i2 * 3 + 1] - pos[i1 * 3 + 1];
    const z1 = pos[i2 * 3 + 2] - pos[i1 * 3 + 2];
    const x2 = pos[i3 * 3] - pos[i1 * 3];
    const y2 = pos[i3 * 3 + 1] - pos[i1 * 3 + 1];
    const z2 = pos[i3 * 3 + 2] - pos[i1 * 3 + 2];
    const s1 = uv[i2 * 2] - uv[i1 * 2];
    const t1 = uv[i2 * 2 + 1] - uv[i1 * 2 + 1];
    const s2 = uv[i3 * 2] - uv[i1 * 2];
    const t2 = uv[i3 * 2 + 1] - uv[i1 * 2 + 1];
    const denom = s1 * t2 - s2 * t1;
    const r = Math.abs(denom) < 1e-12 ? 0 : 1 / denom;
    const tx = (t2 * x1 - t1 * x2) * r;
    const ty = (t2 * y1 - t1 * y2) * r;
    const tz = (t2 * z1 - t1 * z2) * r;
    tan[i1 * 4] += tx; tan[i1 * 4 + 1] += ty; tan[i1 * 4 + 2] += tz;
    tan[i2 * 4] += tx; tan[i2 * 4 + 1] += ty; tan[i2 * 4 + 2] += tz;
    tan[i3 * 4] += tx; tan[i3 * 4 + 1] += ty; tan[i3 * 4 + 2] += tz;
  }
  for (let i = 0; i < count; i++) {
    const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
    let tx = tan[i * 4], ty = tan[i * 4 + 1], tz = tan[i * 4 + 2];
    const d = nx * tx + ny * ty + nz * tz;
    tx -= nx * d; ty -= ny * d; tz -= nz * d;
    const l = Math.hypot(tx, ty, tz);
    if (l < 1e-8) {
      tx = Math.abs(nx) < 0.9 ? 1 : 0;
      ty = 0;
      tz = Math.abs(nx) < 0.9 ? 0 : 1;
      const d2 = nx * tx + ny * ty + nz * tz;
      tx -= nx * d2; ty -= ny * d2; tz -= nz * d2;
      const l2 = Math.hypot(tx, ty, tz) || 1;
      tx /= l2; ty /= l2; tz /= l2;
    } else {
      tx /= l; ty /= l; tz /= l;
    }
    const cx = ny * tz - nz * ty;
    const cy = nz * tx - nx * tz;
    const cz = nx * ty - ny * tx;
    const w = cx * tan[i * 4] + cy * tan[i * 4 + 1] + cz * tan[i * 4 + 2] < 0 ? -1 : 1;
    tan[i * 4] = tx; tan[i * 4 + 1] = ty; tan[i * 4 + 2] = tz; tan[i * 4 + 3] = w;
  }
  return tan;
}

/* ------------------------------------------------------------- primitives */

/** Axis aligned box. Six faces, hard edges, per-face UVs in metres. */
export function boxGeometry(w, h, d, uvScale = 1) {
  const mesh = createMesh();
  const hw = w / 2, hh = h / 2, hd = d / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-hw, -hh, hd], [hw, -hh, hd], [hw, hh, hd], [-hw, hh, hd]], su: w, sv: h },
    { n: [0, 0, -1], v: [[hw, -hh, -hd], [-hw, -hh, -hd], [-hw, hh, -hd], [hw, hh, -hd]], su: w, sv: h },
    { n: [1, 0, 0], v: [[hw, -hh, hd], [hw, -hh, -hd], [hw, hh, -hd], [hw, hh, hd]], su: d, sv: h },
    { n: [-1, 0, 0], v: [[-hw, -hh, -hd], [-hw, -hh, hd], [-hw, hh, hd], [-hw, hh, -hd]], su: d, sv: h },
    { n: [0, 1, 0], v: [[-hw, hh, hd], [hw, hh, hd], [hw, hh, -hd], [-hw, hh, -hd]], su: w, sv: d },
    { n: [0, -1, 0], v: [[-hw, -hh, -hd], [hw, -hh, -hd], [hw, -hh, hd], [-hw, -hh, hd]], su: w, sv: d },
  ];
  for (const f of faces) {
    const a = pushVertex(mesh, f.v[0][0], f.v[0][1], f.v[0][2], f.n[0], f.n[1], f.n[2], 0, f.sv * uvScale);
    const b = pushVertex(mesh, f.v[1][0], f.v[1][1], f.v[1][2], f.n[0], f.n[1], f.n[2], f.su * uvScale, f.sv * uvScale);
    const c = pushVertex(mesh, f.v[2][0], f.v[2][1], f.v[2][2], f.n[0], f.n[1], f.n[2], f.su * uvScale, 0);
    const dd = pushVertex(mesh, f.v[3][0], f.v[3][1], f.v[3][2], f.n[0], f.n[1], f.n[2], 0, 0);
    pushQuad(mesh, a, b, c, dd);
  }
  return finalizeMesh(mesh);
}

const CUBE_FACES = [
  { n: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] },
  { n: [0, 0, -1], right: [-1, 0, 0], up: [0, 1, 0] },
  { n: [1, 0, 0], right: [0, 0, -1], up: [0, 1, 0] },
  { n: [-1, 0, 0], right: [0, 0, 1], up: [0, 1, 0] },
  { n: [0, 1, 0], right: [1, 0, 0], up: [0, 0, -1] },
  { n: [0, -1, 0], right: [1, 0, 0], up: [0, 0, 1] },
];

/**
 * Rounded box: a subdivided cube projected onto a box with filleted edges.
 * This is what makes cushions, pillows and the AI shell look soft.
 */
export function roundedBoxGeometry(w, h, d, radius = 0.05, segments = 5) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const half = [hx, hy, hz];
  const r = Math.min(radius, hx * 0.98, hy * 0.98, hz * 0.98);
  const seg = Math.max(2, segments | 0);
  const mesh = createMesh();

  for (let f = 0; f < 6; f++) {
    const face = CUBE_FACES[f];
    const start = mesh.position.length / 3;
    for (let j = 0; j <= seg; j++) {
      const v = (j / seg) * 2 - 1;
      for (let i = 0; i <= seg; i++) {
        const u = (i / seg) * 2 - 1;
        const px = face.n[0] + face.right[0] * u + face.up[0] * v;
        const py = face.n[1] + face.right[1] * u + face.up[1] * v;
        const pz = face.n[2] + face.right[2] * u + face.up[2] * v;
        // Scale to the box, then push onto the fillet.
        let x = px * hx, y = py * hy, z = pz * hz;
        const ix = clamp(x, -(hx - r), hx - r);
        const iy = clamp(y, -(hy - r), hy - r);
        const iz = clamp(z, -(hz - r), hz - r);
        let nx = x - ix, ny = y - iy, nz = z - iz;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        pushVertex(mesh, ix + nx * r, iy + ny * r, iz + nz * r, nx, ny, nz,
          ((u + 1) / 2) * (f % 2 === 0 ? w : d) * 1, ((v + 1) / 2) * (f < 4 ? h : d) * 1);
      }
    }
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = start + j * (seg + 1) + i;
        const b = a + 1;
        const c = a + seg + 2;
        const dd = a + seg + 1;
        pushQuad(mesh, a, b, c, dd);
      }
    }
  }
  return finalizeMesh(mesh);
}

/** UV sphere; partial shells supported for face plates and lids. */
export function sphereGeometry(radius = 1, widthSeg = 24, heightSeg = 16, opts = {}) {
  const phiStart = opts.phiStart ?? 0;
  const phiLength = opts.phiLength ?? Math.PI * 2;
  const thetaStart = opts.thetaStart ?? 0;
  const thetaLength = opts.thetaLength ?? Math.PI;
  const scaleY = opts.scaleY ?? 1;
  const mesh = createMesh();
  for (let y = 0; y <= heightSeg; y++) {
    const v = y / heightSeg;
    const theta = thetaStart + v * thetaLength;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let x = 0; x <= widthSeg; x++) {
      const u = x / widthSeg;
      const phi = phiStart + u * phiLength;
      const nx = -sinT * Math.cos(phi);
      const ny = cosT * scaleY;
      const nz = sinT * Math.sin(phi);
      const l = Math.hypot(nx, ny, nz) || 1;
      pushVertex(mesh, nx * radius, ny * radius, nz * radius, nx / l, ny / l, nz / l, u, 1 - v);
    }
  }
  const rowEnd = thetaStart + thetaLength >= Math.PI - 1e-6;
  for (let y = 0; y < heightSeg; y++) {
    for (let x = 0; x < widthSeg; x++) {
      const A = y * (widthSeg + 1) + x;
      const B = A + widthSeg + 1;
      if (y !== 0 || thetaStart > 0) mesh.index.push(A + 1, A, B + 1);
      if (y !== heightSeg - 1 || !rowEnd) mesh.index.push(A, B, B + 1);
    }
  }
  return finalizeMesh(mesh);
}

export function cylinderGeometry(radiusTop = 1, radiusBottom = 1, height = 1, radialSeg = 20, opts = {}) {
  const openEnded = !!opts.openEnded;
  const heightSeg = opts.heightSeg || 1;
  const mesh = createMesh();
  const half = height / 2;
  for (let j = 0; j <= heightSeg; j++) {
    const v = j / heightSeg;
    const y = -half + v * height;
    const radius = radiusBottom + (radiusTop - radiusBottom) * v;
    const slope = (radiusBottom - radiusTop) / (height || 1);
    const nl = Math.hypot(1, slope) || 1;
    for (let i = 0; i <= radialSeg; i++) {
      const u = i / radialSeg;
      const theta = u * Math.PI * 2;
      const sin = Math.sin(theta), cos = Math.cos(theta);
      pushVertex(mesh, radius * cos, y, radius * sin, cos / nl, slope / nl, sin / nl, u, v);
    }
  }
  for (let j = 0; j < heightSeg; j++) {
    for (let i = 0; i < radialSeg; i++) {
      const a = j * (radialSeg + 1) + i;
      const b = a + radialSeg + 1;
      pushQuad(mesh, a, b, b + 1, a + 1);
    }
  }
  if (!openEnded) {
    for (const [capY, capRadius, flip] of [[half, radiusTop, false], [-half, radiusBottom, true]]) {
      if (capRadius <= 1e-6) continue;
      const center = pushVertex(mesh, 0, capY, 0, 0, flip ? -1 : 1, 0, 0.5, 0.5);
      const start = mesh.position.length / 3;
      for (let i = 0; i <= radialSeg; i++) {
        const theta = (i / radialSeg) * Math.PI * 2;
        pushVertex(mesh, capRadius * Math.cos(theta), capY, capRadius * Math.sin(theta),
          0, flip ? -1 : 1, 0, 0.5 + Math.cos(theta) * 0.5, 0.5 + Math.sin(theta) * 0.5);
      }
      for (let i = 0; i < radialSeg; i++) {
        const a = start + i, b = start + i + 1;
        // Centre-first winding matches the cap normal (+Y on top, -Y below).
        if (flip) mesh.index.push(center, a, b);
        else mesh.index.push(center, b, a);
      }
    }
  }
  return finalizeMesh(mesh);
}

export function torusGeometry(radius = 1, tube = 0.1, radialSeg = 28, tubularSeg = 12, arc = Math.PI * 2) {
  const mesh = createMesh();
  for (let j = 0; j <= radialSeg; j++) {
    const u = (j / radialSeg) * arc;
    const cu = Math.cos(u), su = Math.sin(u);
    for (let i = 0; i <= tubularSeg; i++) {
      const v = (i / tubularSeg) * Math.PI * 2;
      const nx = cu * Math.cos(v), ny = Math.sin(v), nz = su * Math.cos(v);
      pushVertex(mesh, cu * radius + nx * tube, ny * tube, su * radius + nz * tube,
        nx, ny, nz, j / radialSeg, i / tubularSeg);
    }
  }
  for (let j = 0; j < radialSeg; j++) {
    for (let i = 0; i < tubularSeg; i++) {
      const a = j * (tubularSeg + 1) + i;
      const b = a + tubularSeg + 1;
      pushQuad(mesh, a, a + 1, b + 1, b);
    }
  }
  return finalizeMesh(mesh);
}

/** Flat quad on the XZ plane facing +Y, with optional height displacement. */
export function planeGeometry(width, depth, segW = 1, segD = 1, displace = null) {
  const mesh = createMesh();
  const hw = width / 2, hd = depth / 2;
  for (let j = 0; j <= segD; j++) {
    const v = j / segD;
    for (let i = 0; i <= segW; i++) {
      const u = i / segW;
      const x = -hw + u * width, z = -hd + v * depth;
      const y = displace ? (displace(u, v, x, z) || 0) : 0;
      pushVertex(mesh, x, y, z, 0, 1, 0, u * width, v * depth);
    }
  }
  for (let j = 0; j < segD; j++) {
    for (let i = 0; i < segW; i++) {
      const a = j * (segW + 1) + i;
      const b = a + segW + 1;
      pushQuad(mesh, a, b, b + 1, a + 1);
    }
  }
  if (displace) recalculateNormals(mesh);
  return finalizeMesh(mesh);
}

/** Vertical quad on the XY plane facing +Z (billboards, screens, wall art). */
export function quadGeometry(width, height, segX = 1, segY = 1, displace = null) {
  const mesh = createMesh();
  const hw = width / 2;
  for (let j = 0; j <= segY; j++) {
    const v = j / segY;
    for (let i = 0; i <= segX; i++) {
      const u = i / segX;
      const x = -hw + u * width, y = v * height;
      const z = displace ? (displace(u, v, x, y) || 0) : 0;
      pushVertex(mesh, x, y, z, 0, 0, 1, u, v);
    }
  }
  for (let j = 0; j < segY; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * (segX + 1) + i;
      const b = a + segX + 1;
      pushQuad(mesh, a, a + 1, b + 1, b);
    }
  }
  if (displace) recalculateNormals(mesh);
  return finalizeMesh(mesh);
}

/** Curtain panel: soft vertical folds, gathered toward the top. */
export function curtainGeometry(width, height, folds = 7, depth = 0.06, segX = 32, segY = 10) {
  return quadGeometry(width, height, segX, segY, (u, v) => {
    const flare = 0.4 + 0.6 * (1 - v * 0.45);
    return Math.sin(u * Math.PI * 2 * folds) * depth * flare;
  });
}

/** Surface of revolution around Y. profile = [[radius, height], ...] */
export function latheGeometry(profile, segments = 24) {
  const mesh = createMesh();
  const n = profile.length;
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const phi = u * Math.PI * 2;
    const sin = Math.sin(phi), cos = Math.cos(phi);
    for (let j = 0; j < n; j++) {
      const r = profile[j][0], y = profile[j][1];
      const prev = profile[Math.max(0, j - 1)];
      const next = profile[Math.min(n - 1, j + 1)];
      const dy = next[1] - prev[1];
      const dr = next[0] - prev[0];
      let nx = dy, ny = -dr;
      const l = Math.hypot(nx, ny) || 1;
      nx /= l; ny /= l;
      pushVertex(mesh, r * cos, y, r * sin, nx * cos, ny, nx * sin, u, j / (n - 1));
    }
  }
  // Vertices are stored profile-major: a+1 walks up the profile, a+n walks
  // around the axis. (A, D, C) + (A, C, B) keeps every triangle facing out.
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      const b = a + n;
      pushQuad(mesh, a, a + 1, b + 1, b);
    }
  }
  return finalizeMesh(mesh);
}

/**
 * A leaf: tapered blade, curled along its length, slightly cupped.
 * Grows along +Y from the origin, faces +Z.
 */
export function leafGeometry(length = 0.3, width = 0.17, curl = 0.45, segL = 7, segW = 5) {
  const mesh = createMesh();
  for (let j = 0; j <= segL; j++) {
    const v = j / segL;
    const y = v * length;
    const profile = Math.sin(Math.pow(v, 0.7) * Math.PI) * (1 - 0.3 * v);
    const bend = curl * v * v * length;
    const twist = 0.55 * v;
    for (let i = 0; i <= segW; i++) {
      const u = (i / segW) * 2 - 1;
      const x = u * width * profile * 0.5;
      const cup = (1 - u * u) * width * 0.3 * profile;
      pushVertex(mesh, x * Math.cos(twist), y, x * Math.sin(twist) - cup - bend,
        0, 0, 1, (u + 1) * 0.5, v);
    }
  }
  for (let j = 0; j < segL; j++) {
    for (let i = 0; i < segW; i++) {
      const a = j * (segW + 1) + i;
      const b = a + segW + 1;
      pushQuad(mesh, a, a + 1, b + 1, b);
    }
  }
  recalculateNormals(mesh);
  return finalizeMesh(mesh);
}

/* --------------------------------------------------------------- helpers */

export function recalculateNormals(mesh) {
  const { position: pos, normal, index } = mesh;
  normal.fill(0);
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normal[a] += nx; normal[a + 1] += ny; normal[a + 2] += nz;
    normal[b] += nx; normal[b + 1] += ny; normal[b + 2] += nz;
    normal[c] += nx; normal[c + 1] += ny; normal[c + 2] += nz;
  }
  for (let i = 0; i < normal.length; i += 3) {
    const l = Math.hypot(normal[i], normal[i + 1], normal[i + 2]) || 1;
    normal[i] /= l; normal[i + 1] /= l; normal[i + 2] /= l;
  }
  return mesh;
}

/** Apply a column-major 4x4 matrix to a finalised mesh in place. */
export function transformMesh(mesh, m) {
  const pos = mesh.position, nor = mesh.normal, tan = mesh.tangent;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    pos[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    pos[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    pos[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  for (let i = 0; i < nor.length; i += 3) {
    const x = nor[i], y = nor[i + 1], z = nor[i + 2];
    const nx = m[0] * x + m[4] * y + m[8] * z;
    const ny = m[1] * x + m[5] * y + m[9] * z;
    const nz = m[2] * x + m[6] * y + m[10] * z;
    const l = Math.hypot(nx, ny, nz) || 1;
    nor[i] = nx / l; nor[i + 1] = ny / l; nor[i + 2] = nz / l;
  }
  if (tan) {
    for (let i = 0; i < tan.length; i += 4) {
      const x = tan[i], y = tan[i + 1], z = tan[i + 2];
      const tx = m[0] * x + m[4] * y + m[8] * z;
      const ty = m[1] * x + m[5] * y + m[9] * z;
      const tz = m[2] * x + m[6] * y + m[10] * z;
      const l = Math.hypot(tx, ty, tz) || 1;
      tan[i] = tx / l; tan[i + 1] = ty / l; tan[i + 2] = tz / l;
    }
  }
  return mesh;
}

/** Concatenate finalised meshes into a single draw call. */
export function mergeMeshes(meshes) {
  let vertices = 0, indices = 0;
  for (const m of meshes) { vertices += m.vertices; indices += m.count; }
  const out = {
    position: new Float32Array(vertices * 3),
    normal: new Float32Array(vertices * 3),
    uv: new Float32Array(vertices * 2),
    tangent: new Float32Array(vertices * 4),
    index: new Uint32Array(indices),
  };
  let vo = 0, io = 0;
  for (const m of meshes) {
    out.position.set(m.position, vo * 3);
    out.normal.set(m.normal, vo * 3);
    out.uv.set(m.uv, vo * 2);
    out.tangent.set(m.tangent, vo * 4);
    out.index.set(m.index, io);
    for (let i = 0; i < m.count; i++) out.index[io + i] += vo;
    vo += m.vertices;
    io += m.count;
  }
  out.count = indices;
  out.vertices = vertices;
  return out;
}
