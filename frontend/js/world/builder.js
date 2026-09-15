/**
 * Collects static geometry per material and merges it, so the whole room is a
 * couple of dozen draw calls instead of a few hundred.
 */

export class SceneBuilder {
  constructor(renderer) {
    this.renderer = renderer;
    this.batches = new Map();
    this.dynamics = [];
    this.triangles = 0;
  }

  /** Add static geometry that will be merged with everything sharing its material. */
  add(mesh, matrix, material, opts = {}) {
    let batch = this.batches.get(material);
    if (!batch) {
      batch = { material, meshes: [], opts };
      this.batches.set(material, batch);
    }
    batch.meshes.push(cloneAndTransform(mesh, matrix));
    this.triangles += mesh.count / 3;
    return batch;
  }

  /** Add something that moves (or whose material changes at run time). */
  addDynamic(mesh, material, opts = {}) {
    const item = this.renderer.addDynamic(mesh, material, opts);
    this.dynamics.push(item);
    this.triangles += mesh.count / 3;
    return item;
  }

  finalize() {
    const items = [];
    for (const batch of this.batches.values()) {
      const merged = mergeAll(batch.meshes);
      const buffers = this.renderer.createMesh(merged);
      items.push(this.renderer.addItem({
        buffers,
        material: batch.material,
        castShadow: batch.opts.castShadow,
        receiveShadow: batch.opts.receiveShadow,
        tag: batch.opts.tag,
      }));
    }
    this.batches.clear();
    return items;
  }

  get drawCalls() {
    return this.renderer.items.length + this.renderer.transparent.length;
  }
}

function cloneAndTransform(mesh, matrix) {
  const copy = {
    position: new Float32Array(mesh.position),
    normal: new Float32Array(mesh.normal),
    uv: new Float32Array(mesh.uv),
    tangent: new Float32Array(mesh.tangent),
    index: new Uint32Array(mesh.index),
    count: mesh.count,
    vertices: mesh.vertices,
  };
  const identity = isIdentity(matrix);
  if (!identity) transformInPlace(copy, matrix);
  return copy;
}

function isIdentity(m) {
  return m[0] === 1 && m[5] === 1 && m[10] === 1 && m[15] === 1 &&
    m[12] === 0 && m[13] === 0 && m[14] === 0 &&
    m[1] === 0 && m[2] === 0 && m[3] === 0 &&
    m[4] === 0 && m[6] === 0 && m[7] === 0 &&
    m[8] === 0 && m[9] === 0 && m[11] === 0;
}

function transformInPlace(mesh, m) {
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

function mergeAll(meshes) {
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
    for (let i = 0; i < m.count; i++) out.index[io + i] = m.index[i] + vo;
    vo += m.vertices;
    io += m.count;
  }
  out.count = indices;
  out.vertices = vertices;
  return out;
}
