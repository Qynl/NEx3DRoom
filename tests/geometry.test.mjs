/**
 * Optional developer check for the procedural geometry (needs Node 18+).
 *
 *   node tests/geometry.test.mjs
 *
 * The application itself never needs Node — this only verifies that every
 * builder produces valid, correctly wound, NaN-free meshes.
 */

import {
  boxGeometry, roundedBoxGeometry, sphereGeometry, cylinderGeometry,
  torusGeometry, planeGeometry, quadGeometry, curtainGeometry,
  latheGeometry, leafGeometry, mergeMeshes, transformMesh,
} from '../frontend/js/core/geometry.js';

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

function finite(arrays) {
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  }
  return true;
}

function indicesValid(mesh) {
  const n = mesh.position.length / 3;
  if (mesh.index.length % 3 !== 0) return false;
  for (let i = 0; i < mesh.index.length; i++) {
    if (mesh.index[i] < 0 || mesh.index[i] >= n) return false;
  }
  return true;
}

function normalsUnit(mesh) {
  for (let i = 0; i < mesh.normal.length; i += 3) {
    const l = Math.hypot(mesh.normal[i], mesh.normal[i + 1], mesh.normal[i + 2]);
    if (Math.abs(l - 1) > 1e-3) return false;
  }
  return true;
}

function tangentsValid(mesh) {
  for (let i = 0; i < mesh.tangent.length; i += 4) {
    const l = Math.hypot(mesh.tangent[i], mesh.tangent[i + 1], mesh.tangent[i + 2]);
    if (Math.abs(l - 1) > 1e-3) return false;
    if (Math.abs(mesh.tangent[i + 3]) !== 1) return false;
    const d = mesh.tangent[i] * mesh.normal[(i / 4) * 3]
            + mesh.tangent[i + 1] * mesh.normal[(i / 4) * 3 + 1]
            + mesh.tangent[i + 2] * mesh.normal[(i / 4) * 3 + 2];
    if (Math.abs(d) > 1e-3) return false;
  }
  return true;
}

/** Fraction of triangles whose winding agrees with their vertex normals. */
function windingScore(mesh) {
  const { position: p, normal: n, index } = mesh;
  let good = 0, total = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t] * 3, b = index[t + 1] * 3, c = index[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-12) continue; // degenerate
    const an = (n[a] + n[b] + n[c]) / 3;
    const ay = (n[a + 1] + n[b + 1] + n[c + 1]) / 3;
    const az = (n[a + 2] + n[b + 2] + n[c + 2]) / 3;
    total++;
    if ((fx * an + fy * ay + fz * az) / fl > 0) good++;
  }
  return { score: total ? good / total : 0, total };
}

/** Outward-facing test for convex shapes centred on the origin. */
function outwardScore(mesh, centre = [0, 0, 0]) {
  const { position: p, normal: n } = mesh;
  let good = 0, total = 0;
  for (let i = 0; i < p.length; i += 3) {
    const dx = p[i] - centre[0], dy = p[i + 1] - centre[1], dz = p[i + 2] - centre[2];
    const l = Math.hypot(dx, dy, dz);
    if (l < 1e-6) continue;
    total++;
    if ((n[i] * dx + n[i + 1] * dy + n[i + 2] * dz) / l > 0) good++;
  }
  return total ? good / total : 1;
}

console.log('geometry: primitives');

const closed = [
  ['box', boxGeometry(1, 0.5, 0.3)],
  ['roundedBox', roundedBoxGeometry(1, 0.5, 0.3, 0.09, 6)],
  ['sphere', sphereGeometry(0.5, 20, 14)],
  ['sphere(partial)', sphereGeometry(0.5, 20, 10, { thetaStart: 0, thetaLength: Math.PI * 0.6 })],
  ['cylinder', cylinderGeometry(0.3, 0.4, 0.8, 18)],
  ['cone', cylinderGeometry(0, 0.4, 0.8, 16)],
  ['torus', torusGeometry(0.4, 0.08, 20, 10)],
  ['lathe(vase)', latheGeometry([[0.02, 0], [0.14, 0.02], [0.1, 0.2], [0.13, 0.34], [0.12, 0.36]], 20)],
];

for (const [name, mesh] of closed) {
  const w = windingScore(mesh);
  const o = outwardScore(mesh);
  check(finite([mesh.position, mesh.normal, mesh.uv, mesh.tangent]), `${name}: finite data`);
  check(indicesValid(mesh), `${name}: index range (${mesh.vertices} verts, ${mesh.count / 3} tris)`);
  check(normalsUnit(mesh), `${name}: unit normals`);
  check(tangentsValid(mesh), `${name}: tangents orthogonal + unit`);
  check(w.score > 0.995, `${name}: winding CCW outward (${(w.score * 100).toFixed(1)}% of ${w.total})`);
  if (!name.includes('partial') && !name.includes('torus')) check(o > 0.995, `${name}: normals point outward (${(o * 100).toFixed(1)}%)`);
}

console.log('geometry: open surfaces');

const open = [
  ['plane(+Y)', planeGeometry(2, 2, 4, 4), 1],
  ['plane(displaced)', planeGeometry(2, 2, 8, 8, (u, v) => Math.sin(u * 6) * 0.05), 1],
  ['quad(+Z)', quadGeometry(1.6, 0.9, 2, 2), 2],
  ['curtain(+Z)', curtainGeometry(0.6, 2.1, 6, 0.05, 24, 8), 2],
  ['leaf(+Z)', leafGeometry(0.3, 0.17, 0.4), 2],
];

for (const [name, mesh, axis] of open) {
  const w = windingScore(mesh);
  let facing = 0, total = 0;
  for (let i = 0; i < mesh.normal.length; i += 3) {
    total++;
    if (mesh.normal[i + axis] > 0) facing++;
  }
  check(finite([mesh.position, mesh.normal, mesh.tangent]), `${name}: finite data`);
  check(indicesValid(mesh), `${name}: index range`);
  check(w.score > 0.995, `${name}: winding agrees with normals (${(w.score * 100).toFixed(1)}%)`);
  check(facing / total > 0.85, `${name}: faces the expected axis (${(facing / total * 100).toFixed(0)}%)`);
}

console.log('geometry: batching');

const a = transformMesh(structuredCloneLike(boxGeometry(0.2, 0.2, 0.2)), translate(1, 0, 0));
const b = transformMesh(structuredCloneLike(boxGeometry(0.2, 0.2, 0.2)), translate(-1, 0, 0));
const merged = mergeMeshes([a, b]);
check(merged.vertices === a.vertices + b.vertices, `merge: vertex count ${merged.vertices}`);
check(merged.count === a.count + b.count, `merge: index count ${merged.count}`);
check(indicesValid(merged), 'merge: index range after offset');
const xs = Array.from(merged.position.filter((_, i) => i % 3 === 0));
check(Math.min(...xs) < -0.9 && Math.max(...xs) > 0.9, 'merge: both boxes kept their offset');

function translate(x, y, z) {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}
function structuredCloneLike(mesh) {
  return {
    position: new Float32Array(mesh.position),
    normal: new Float32Array(mesh.normal),
    uv: new Float32Array(mesh.uv),
    tangent: new Float32Array(mesh.tangent),
    index: new Uint32Array(mesh.index),
    count: mesh.count,
    vertices: mesh.vertices,
  };
}

console.log(failures === 0 ? '\nAll geometry checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
