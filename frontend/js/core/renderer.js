/**
 * The renderer: shadow pass, lit pass into an HDR multisampled target, then a
 * cheap bloom and the final tonemap. Everything is drawn from one flat list of
 * items so a frame is a handful of state changes and ~40 draw calls.
 */

import {
  BRIGHT_FRAG, BLUR_FRAG, COMPOSITE_FRAG, DEPTH_FRAG, DEPTH_VERT,
  POST_VERT, PBR_FRAG, PBR_VERT, UNLIT_FRAG, UNLIT_VERT,
} from './shaders.js';
import { DepthTexture, Framebuffer, MeshBuffers, Program, createTexture2D } from './gl.js';
import { m3normalFromMat4, m4identity, m4lookAt, m4multiply, m4ortho, v3 } from './math.js';

const MAX_LIGHTS = 8;

export class Renderer {
  constructor(gl, caps, quality = 'high') {
    this.gl = gl;
    this.caps = caps;
    this.quality = quality;
    this.items = [];
    this.transparent = [];
    this.lights = [];
    this.stats = { drawCalls: 0, triangles: 0, shadowDraws: 0 };

    this.lightPos = new Float32Array(MAX_LIGHTS * 3);
    this.lightColor = new Float32Array(MAX_LIGHTS * 3);
    this.lightParams = new Float32Array(MAX_LIGHTS * 2);

    this.env = {
      sunDir: new Float32Array([0.4, 0.7, -0.6]),
      sunColor: new Float32Array([3, 2.8, 2.4]),
      skyColor: new Float32Array([0.3, 0.34, 0.42]),
      groundColor: new Float32Array([0.16, 0.13, 0.11]),
      ambient: 0.55,
      envIntensity: 1.0,
      exposure: 1.0,
      fogColor: new Float32Array([0.05, 0.055, 0.07]),
      fogDensity: 0.012,
      shadowStrength: 0.85,
      bloom: 0.55,
      vignette: 0.55,
      grain: 0.012,
      tint: new Float32Array([1, 1, 1]),
      texture: null,
      maxLod: 5,
    };

    this.shadowSize = quality === 'low' ? 1024 : quality === 'medium' ? 1536 : 2048;
    this.shadowEnabled = quality !== 'low';
    this.bloomEnabled = quality !== 'low';
    this.msaaSamples = caps.maxSamples >= 4 ? 4 : caps.maxSamples;
    if (quality === 'low') this.msaaSamples = 0;

    this.viewProj = new Float32Array(16);
    this.lightViewProj = new Float32Array(16);
    this.normalMat = new Float32Array(9);
    this.identity = m4identity(new Float32Array(16));
    this.tmpMat = new Float32Array(16);

    this._buildPrograms();
    this.emptyVao = gl.createVertexArray();
  }

  _buildPrograms() {
    const gl = this.gl;
    this.pbr = new Program(gl, PBR_VERT, PBR_FRAG, 'pbr');
    this.depth = new Program(gl, DEPTH_VERT, DEPTH_FRAG, 'depth');
    this.unlit = new Program(gl, UNLIT_VERT, UNLIT_FRAG, 'unlit');
    this.bright = new Program(gl, POST_VERT, BRIGHT_FRAG, 'bright');
    this.blur = new Program(gl, POST_VERT, BLUR_FRAG, 'blur');
    this.composite = new Program(gl, POST_VERT, COMPOSITE_FRAG, 'composite');
  }

  /* ----------------------------------------------------------- resources */

  createMesh(mesh) {
    return new MeshBuffers(this.gl, mesh);
  }

  createTexture(canvas, opts = {}) {
    return createTexture2D(this.gl, {
      source: canvas,
      wrapS: opts.clamp ? this.gl.CLAMP_TO_EDGE : this.gl.REPEAT,
      wrapT: opts.clamp ? this.gl.CLAMP_TO_EDGE : this.gl.REPEAT,
      anisotropy: Math.min(8, this.caps.maxAnisotropy || 1),
      ...opts,
    });
  }

  updateTexture(texture, source) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Upload a mesh and register it as an item that changes at run time. */
  addDynamic(mesh, material, opts = {}) {
    const buffers = this.createMesh(mesh);
    return this.addItem({ buffers, material, dynamic: true, ...opts });
  }

  addItem(item) {
    const entry = {
      buffers: item.buffers,
      material: item.material,
      model: item.model || m4identity(new Float32Array(16)),
      castShadow: item.castShadow !== false,
      receiveShadow: item.receiveShadow !== false,
      visible: true,
      sortKey: item.sortKey ?? 0,
      tag: item.tag || '',
      dynamic: !!item.dynamic,
    };
    const blend = entry.material.blend || 'opaque';
    if (blend === 'opaque') this.items.push(entry);
    else this.transparent.push(entry);
    return entry;
  }

  clear() {
    this.items.length = 0;
    this.transparent.length = 0;
  }

  resize(width, height, pixelRatio) {
    const gl = this.gl;
    const w = Math.max(2, Math.floor(width));
    const h = Math.max(2, Math.floor(height));
    if (this.width === w && this.height === h) return;
    this.width = w;
    this.height = h;
    this.pixelRatio = pixelRatio;

    const hdr = this.caps.floatBuffers || this.caps.halfFloatBuffers;
    const samples = hdr ? this.msaaSamples : 0;

    if (this.sceneTarget) this.sceneTarget.dispose();
    if (this.resolveTarget) this.resolveTarget.dispose();
    if (this.bloomA) this.bloomA.dispose();
    if (this.bloomB) this.bloomB.dispose();

    this.sceneTarget = new Framebuffer(gl, { width: w, height: h, samples, hdr, depth: true });
    if (samples > 1) {
      this.resolveTarget = new Framebuffer(gl, { width: w, height: h, samples: 0, hdr, depth: false });
    } else {
      this.resolveTarget = this.sceneTarget;
    }

    const bw = Math.max(2, Math.floor(w / 4));
    const bh = Math.max(2, Math.floor(h / 4));
    this.bloomA = new Framebuffer(gl, { width: bw, height: bh, samples: 0, hdr, depth: false });
    this.bloomB = new Framebuffer(gl, { width: bw, height: bh, samples: 0, hdr, depth: false });

    if (!this.shadowMap && this.shadowEnabled) {
      this.shadowMap = new DepthTexture(gl, this.shadowSize, this.shadowSize);
    }
    this.targetsReady = this.sceneTarget.complete && this.bloomA.complete;
  }

  /* --------------------------------------------------------------- frame */

  setLight(index, pos, color, range, radius = 0.06) {
    if (index >= MAX_LIGHTS) return;
    this.lightPos[index * 3] = pos[0];
    this.lightPos[index * 3 + 1] = pos[1];
    this.lightPos[index * 3 + 2] = pos[2];
    this.lightColor[index * 3] = color[0];
    this.lightColor[index * 3 + 1] = color[1];
    this.lightColor[index * 3 + 2] = color[2];
    this.lightParams[index * 2] = range;
    this.lightParams[index * 2 + 1] = radius;
  }

  render(camera, time) {
    const gl = this.gl;
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;
    this.stats.shadowDraws = 0;

    if (!this.targetsReady) return this.stats;

    m4multiply(this.viewProj, camera.projection, camera.view);

    if (this.shadowEnabled && this.shadowMap) this._shadowPass(camera);

    // ---- lit pass ---------------------------------------------------------
    this.sceneTarget.bind();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.clearColor(0.01, 0.012, 0.016, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.pbr.use();
    this._bindSharedUniforms(this.pbr, camera);
    for (const item of this.items) {
      if (!item.visible) continue;
      this._drawItem(item, this.pbr);
    }

    // ---- transparent + additive ------------------------------------------
    if (this.transparent.length) {
      const cameraPos = camera.position;
      this.transparent.sort((a, b) => {
        const da = distanceSq(a.model, cameraPos);
        const db = distanceSq(b.model, cameraPos);
        return db - da;
      });
      gl.enable(gl.BLEND);
      gl.depthMask(false);
      for (const item of this.transparent) {
        if (!item.visible) continue;
        const mode = item.material.blend;
        if (mode === 'additive') gl.blendFunc(gl.ONE, gl.ONE);
        else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        if (item.material.cull === false) gl.disable(gl.CULL_FACE);
        if (item.material.program === 'unlit') this._drawUnlit(item, camera);
        else this._drawItem(item, this.pbr);
        if (item.material.cull === false) gl.enable(gl.CULL_FACE);
      }
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    // ---- post --------------------------------------------------------------
    if (this.sceneTarget !== this.resolveTarget) this.sceneTarget.resolveTo(this.resolveTarget);

    if (this.bloomEnabled) this._bloomPass();
    this._compositePass(time);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.stats;
  }

  _bindSharedUniforms(program, camera) {
    const gl = this.gl;
    program.set('uViewProj', this.viewProj);
    program.set('uCameraPos', camera.position);
    program.set('uSunDir', this.env.sunDir);
    program.set('uSunColor', this.env.sunColor);
    program.set('uSkyColor', this.env.skyColor);
    program.set('uGroundColor', this.env.groundColor);
    program.set('uAmbientIntensity', this.env.ambient);
    program.set('uEnvIntensity', this.env.envIntensity);
    program.set('uEnvMaxLod', this.env.maxLod);
    program.set('uFogColor', this.env.fogColor);
    program.set('uFogDensity', this.env.fogDensity);
    program.set('uShadowStrength', this.env.shadowStrength);
    program.set('uShadowTexel', new Float32Array([1 / this.shadowSize, 1 / this.shadowSize]));
    program.set('uLightViewProj', this.lightViewProj);
    program.set('uShadowEnabled', this.shadowEnabled && this.shadowMap ? 1 : 0);
    program.set('uLightCount', this.lights.length);
    program.set('uLightPos', this.lightPos);
    program.set('uLightColor', this.lightColor);
    program.set('uLightParams', this.lightParams);

    gl.activeTexture(gl.TEXTURE3);
    if (this.env.texture) gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.env.texture);
    program.set('uEnvMap', 3);

    gl.activeTexture(gl.TEXTURE4);
    if (this.shadowMap) gl.bindTexture(gl.TEXTURE_2D, this.shadowMap.texture);
    program.set('uShadowMap', 4);
  }

  _drawItem(item, program) {
    const gl = this.gl;
    const mat = item.material;
    program.set('uModel', item.model);
    m3normalFromMat4(this.normalMat, item.model);
    program.set('uNormalMat', this.normalMat);
    program.set('uAlbedo', mat.albedo || [0.8, 0.8, 0.8]);
    program.set('uMetallic', mat.metallic ?? 0);
    program.set('uRoughness', mat.roughness ?? 0.7);
    program.set('uEmissive', mat.emissive || [0, 0, 0]);
    program.set('uEmissiveStrength', mat.emissiveStrength ?? 0);
    program.set('uOpacity', mat.opacity ?? 1);
    program.set('uNormalScale', mat.normalScale ?? 1);
    program.set('uTranslucency', mat.translucent ?? 0);
    program.set('uUVScale', mat.uvScale || [1, 1]);

    const maps = mat.maps || {};
    let flags = 0;
    gl.activeTexture(gl.TEXTURE0);
    if (maps.albedo) { gl.bindTexture(gl.TEXTURE_2D, maps.albedo); flags |= 1; }
    gl.activeTexture(gl.TEXTURE1);
    if (maps.normal) { gl.bindTexture(gl.TEXTURE_2D, maps.normal); flags |= 2; }
    gl.activeTexture(gl.TEXTURE2);
    if (maps.rough) { gl.bindTexture(gl.TEXTURE_2D, maps.rough); flags |= 4; }
    program.set('uMapFlags', new Float32Array([
      maps.albedo ? 1 : 0, maps.normal ? 1 : 0, maps.rough ? 1 : 0, 0,
    ]));
    void flags;
    program.set('uAlbedoMap', 0);
    program.set('uNormalMap', 1);
    program.set('uRoughMap', 2);

    if (mat.cull === false) gl.disable(gl.CULL_FACE);
    item.buffers.bind().draw();
    if (mat.cull === false) gl.enable(gl.CULL_FACE);
    this.stats.drawCalls++;
    this.stats.triangles += item.buffers.count / 3;
  }

  _drawUnlit(item, camera) {
    const gl = this.gl;
    const mat = item.material;
    this.unlit.use();
    this.unlit.set('uViewProj', this.viewProj);
    this.unlit.set('uModel', item.model);
    this.unlit.set('uColor', mat.color || [1, 1, 1, 1]);
    this.unlit.set('uUseTexture', mat.texture ? 1 : 0);
    this.unlit.set('uSoftEdge', mat.softEdge ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0);
    if (mat.texture) gl.bindTexture(gl.TEXTURE_2D, mat.texture);
    this.unlit.set('uTexture', 0);
    item.buffers.bind().draw();
    this.stats.drawCalls++;
    this.stats.triangles += item.buffers.count / 3;
    this.pbr.use();
    this._bindSharedUniforms(this.pbr, camera);
  }

  _shadowPass(camera) {
    const gl = this.gl;
    const target = this._computeLightMatrix(camera);
    this.shadowMap.bind();
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT); // front facing culling reduces shadow acne
    gl.clear(gl.DEPTH_BUFFER_BIT);

    this.depth.use();
    this.depth.set('uLightViewProj', target);
    for (const item of this.items) {
      if (!item.visible || !item.castShadow) continue;
      if (item.material.opacity !== undefined && item.material.opacity < 0.6) continue;
      this.depth.set('uModel', item.model);
      item.buffers.bind().draw();
      this.stats.shadowDraws++;
    }
    gl.cullFace(gl.BACK);
    this.shadowDrawMatrix = target;
  }

  /** Tight orthographic box around the room, aligned with the sun. */
  _computeLightMatrix(camera) {
    const dir = this.env.sunDir;
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const d = [dir[0] / len, dir[1] / len, dir[2] / len];
    const centre = [0, 1.1, 0];
    const dist = 9.5;
    const eye = v3(centre[0] + d[0] * dist, centre[1] + d[1] * dist, centre[2] + d[2] * dist);
    const view = m4lookAt(new Float32Array(16), eye, v3(centre[0], centre[1], centre[2]), v3(0, 1, 0));
    const half = 5.2;
    const proj = m4ortho(new Float32Array(16), -half, half, -half, half, 0.5, 24);
    m4multiply(this.lightViewProj, proj, view);
    return this.lightViewProj;
  }

  _bloomPass() {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);

    this.bloomA.bind();
    this.bright.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolveTarget.texture);
    this.bright.set('uTexture', 0);
    this.bright.set('uThreshold', this.caps.floatBuffers ? 1.05 : 0.72);
    this.bright.set('uSoftKnee', 0.5);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.blur.use();
    const bw = this.bloomA.width, bh = this.bloomA.height;
    // Two ping pong rounds give a wide, soft halo without much cost.
    for (let i = 0; i < 2; i++) {
      const scale = i === 0 ? 1 : 2;
      this.bloomB.bind();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomA.texture);
      this.blur.set('uTexture', 0);
      this.blur.set('uDirection', new Float32Array([scale / bw, 0]));
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this.bloomA.bind();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomB.texture);
      this.blur.set('uTexture', 0);
      this.blur.set('uDirection', new Float32Array([0, scale / bh]));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  _compositePass(time) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.emptyVao);

    this.composite.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.resolveTarget.texture);
    this.composite.set('uScene', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bloomEnabled ? this.bloomA.texture : this.resolveTarget.texture);
    this.composite.set('uBloom', 1);
    this.composite.set('uExposure', this.env.exposure);
    this.composite.set('uBloomStrength', this.bloomEnabled ? this.env.bloom : 0);
    this.composite.set('uVignette', this.env.vignette);
    this.composite.set('uGrain', this.env.grain);
    this.composite.set('uTime', time);
    this.composite.set('uTint', this.env.tint);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

function distanceSq(model, point) {
  const dx = model[12] - point[0];
  const dy = model[13] - point[1];
  const dz = model[14] - point[2];
  return dx * dx + dy * dy + dz * dz;
}
