/**
 * Thin WebGL2 wrapper: context, shader programs, mesh buffers, textures and
 * framebuffers. No engine, no dependencies - just the calls the room needs.
 */

export function createContext(canvas, options = {}) {
  const defaults = {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: false,          // we resolve MSAA ourselves for HDR output
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
    desynchronized: false,
    failIfMajorPerformanceCaveat: false,
  };
  const gl = canvas.getContext('webgl2', { ...defaults, ...options });
  if (!gl) return null;
  return gl;
}

export class Capabilities {
  constructor(gl) {
    this.gl = gl;
    this.maxSamples = gl.getParameter(gl.MAX_SAMPLES) || 0;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.floatBuffers = !!gl.getExtension('EXT_color_buffer_float');
    this.halfFloatBuffers = !!gl.getExtension('EXT_color_buffer_half_float') || this.floatBuffers;
    this.anisotropyExt = gl.getExtension('EXT_texture_filter_anisotropic');
    this.maxAnisotropy = this.anisotropyExt
      ? gl.getParameter(this.anisotropyExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
    this.renderer = safeString(gl.getParameter(gl.RENDERER));
    this.vendor = safeString(gl.getParameter(gl.VENDOR));
    const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugExt) {
      this.renderer = safeString(gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL)) || this.renderer;
    }
  }
}

function safeString(value) {
  return typeof value === 'string' ? value : '';
}

/* ------------------------------------------------------------- programs -- */

export class Program {
  constructor(gl, vertSource, fragSource, label = 'program') {
    this.gl = gl;
    this.label = label;
    this.uniforms = new Map();
    this.handle = this._build(vertSource, fragSource);
    this._indexUniforms();
  }

  _compile(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || 'unknown error';
      gl.deleteShader(shader);
      throw new Error(`[${this.label}] shader compile failed: ${log}\n${annotate(source)}`);
    }
    return shader;
  }

  _build(vs, fs) {
    const gl = this.gl;
    const vert = this._compile(gl.VERTEX_SHADER, vs);
    const frag = this._compile(gl.FRAGMENT_SHADER, fs);
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || 'unknown error';
      throw new Error(`[${this.label}] link failed: ${log}`);
    }
    return program;
  }

  _indexUniforms() {
    const gl = this.gl;
    const count = gl.getProgramParameter(this.handle, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(this.handle, i);
      if (!info) continue;
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(name, {
        location: gl.getUniformLocation(this.handle, info.name),
        type: info.type,
        size: info.size,
      });
    }
  }

  use() {
    this.gl.useProgram(this.handle);
    return this;
  }

  has(name) {
    const entry = this.uniforms.get(name);
    return !!entry && entry.location !== null;
  }

  /** Type aware uniform setter; unknown names are ignored silently. */
  set(name, value) {
    const entry = this.uniforms.get(name);
    if (!entry || entry.location === null || value === undefined || value === null) return this;
    const gl = this.gl;
    const loc = entry.location;
    switch (entry.type) {
      case gl.FLOAT: gl.uniform1f(loc, value); break;
      case gl.INT:
      case gl.SAMPLER_2D:
      case gl.SAMPLER_CUBE:
      case gl.SAMPLER_2D_SHADOW: gl.uniform1i(loc, value); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, value); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, value); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, value); break;
      case gl.INT_VEC2: gl.uniform2iv(loc, value); break;
      case gl.INT_VEC3: gl.uniform3iv(loc, value); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, value); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(loc, false, value); break;
      case gl.BOOL: gl.uniform1i(loc, value ? 1 : 0); break;
      default: break;
    }
    return this;
  }

  setMany(obj) {
    for (const key in obj) this.set(key, obj[key]);
    return this;
  }

  dispose() {
    this.gl.deleteProgram(this.handle);
  }
}

/** Adds line numbers next to a GLSL error so shader bugs are easy to find. */
function annotate(source) {
  const lines = source.split('\n');
  return lines
    .map((line, i) => `${String(i + 1).padStart(3, ' ')}| ${line}`)
    .slice(0, 400)
    .join('\n');
}

/* -------------------------------------------------------------- buffers -- */

export class MeshBuffers {
  constructor(gl, mesh) {
    this.gl = gl;
    this.count = mesh.count;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 12 * 4; // pos3 + normal3 + uv2 + tangent4
    const data = interleave(mesh);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.FLOAT, false, stride, 32);

    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.index, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  bind() {
    this.gl.bindVertexArray(this.vao);
    return this;
  }

  draw(mode) {
    const gl = this.gl;
    gl.drawElements(mode || gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
  }
}

function interleave(mesh) {
  const n = mesh.vertices;
  const out = new Float32Array(n * 12);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    out[o] = mesh.position[i * 3];
    out[o + 1] = mesh.position[i * 3 + 1];
    out[o + 2] = mesh.position[i * 3 + 2];
    out[o + 3] = mesh.normal[i * 3];
    out[o + 4] = mesh.normal[i * 3 + 1];
    out[o + 5] = mesh.normal[i * 3 + 2];
    out[o + 6] = mesh.uv[i * 2];
    out[o + 7] = mesh.uv[i * 2 + 1];
    out[o + 8] = mesh.tangent[i * 4];
    out[o + 9] = mesh.tangent[i * 4 + 1];
    out[o + 10] = mesh.tangent[i * 4 + 2];
    out[o + 11] = mesh.tangent[i * 4 + 3];
  }
  return out;
}

/* ------------------------------------------------------------- textures -- */

export function createTexture2D(gl, opts = {}) {
  const target = gl.TEXTURE_2D;
  const tex = gl.createTexture();
  gl.bindTexture(target, tex);
  const {
    width = 1, height = 1,
    source = null,
    internalFormat = gl.RGBA8,
    format = gl.RGBA,
    type = gl.UNSIGNED_BYTE,
    wrapS = gl.REPEAT, wrapT = gl.REPEAT,
    minFilter = gl.LINEAR_MIPMAP_LINEAR,
    magFilter = gl.LINEAR,
    mips = true,
    anisotropy = 1,
    flipY = false,
  } = opts;

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  if (source) {
    gl.texImage2D(target, 0, internalFormat, format, type, source);
  } else {
    gl.texImage2D(target, 0, internalFormat, width, height, 0, format, type, null);
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  gl.texParameteri(target, gl.TEXTURE_WRAP_S, wrapS);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, wrapT);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, magFilter);
  if (anisotropy > 1) {
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) gl.texParameterf(target, ext.TEXTURE_MAX_ANISOTROPY_EXT, anisotropy);
  }
  if (mips) gl.generateMipmap(target);
  gl.bindTexture(target, null);
  return tex;
}

export function updateTexture2D(gl, tex, source, flipY = true) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flipY);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/** HDR cube map from six Float32Array faces (RGBA). */
export function createCubeTexture(gl, faces, size, opts = {}) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
  const useHalf = opts.halfFloat !== false;
  const internalFormat = useHalf ? gl.RGBA16F : gl.RGBA8;
  const type = useHalf ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  for (let i = 0; i < 6; i++) {
    const data = useHalf ? floatToHalfRGBA(faces[i]) : u8FromFloat(faces[i]);
    gl.texImage2D(
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, internalFormat,
      size, size, 0, gl.RGBA, type, data
    );
  }
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
  return tex;
}

export function floatToHalfRGBA(floats) {
  const out = new Uint16Array(floats.length);
  for (let i = 0; i < floats.length; i++) out[i] = toHalf(floats[i]);
  return out;
}

export function u8FromFloat(floats) {
  const out = new Uint8Array(floats.length);
  for (let i = 0; i < floats.length; i++) {
    out[i] = Math.max(0, Math.min(255, Math.round(floats[i] * 255)));
  }
  return out;
}

/** IEEE 754 half precision conversion (fast path for normals ranges). */
export function toHalf(value) {
  const f32 = toHalf._f32 || (toHalf._f32 = new Float32Array(1));
  const u32 = toHalf._u32 || (toHalf._u32 = new Uint32Array(f32.buffer));
  f32[0] = value;
  const x = u32[0];
  const bits = (x >> 16) & 0x8000;
  let m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) {
    return bits | 0x7c00 | ((e === 255 ? (x & 0x007fffff) : 0) ? 0x0200 : 0);
  }
  if (e < 113) {
    m |= 0x0800;
    return bits | ((m >> (114 - e)) + ((m >> (113 - e)) & 1));
  }
  return bits | ((e - 112) << 10) | (m >> 1) + (m & 1);
}

/* ---------------------------------------------------------- framebuffers -- */

export class Framebuffer {
  constructor(gl, opts) {
    this.gl = gl;
    this.width = opts.width;
    this.height = opts.height;
    this.samples = opts.samples || 0;
    this.depth = opts.depth !== false;
    this.hdr = !!opts.hdr;
    this.handle = gl.createFramebuffer();
    this._build();
  }

  _build() {
    const gl = this.gl;
    const internal = this.hdr && gl.RGBA16F ? gl.RGBA16F : gl.RGBA8;
    const type = this.hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.handle);

    if (this.samples > 1) {
      this.colorRenderbuffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorRenderbuffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, internal, this.width, this.height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.colorRenderbuffer);

      if (this.depth) {
        this.depthRenderbuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRenderbuffer);
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, this.width, this.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRenderbuffer);
      }
    } else {
      this.texture = createTexture2D(gl, {
        width: this.width, height: this.height,
        internalFormat: internal, type,
        wrapS: gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE,
        minFilter: gl.LINEAR, magFilter: gl.LINEAR, mips: false,
      });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texture, 0);
      if (this.depth) {
        this.depthRenderbuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRenderbuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.width, this.height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRenderbuffer);
      }
    }

    this.status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }

  get complete() {
    return this.status === this.gl.FRAMEBUFFER_COMPLETE;
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.handle);
    gl.viewport(0, 0, this.width, this.height);
    return this;
  }

  /** MSAA resolve into a plain texture framebuffer. */
  resolveTo(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.handle);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.handle);
    gl.blitFramebuffer(
      0, 0, this.width, this.height,
      0, 0, target.width, target.height,
      gl.COLOR_BUFFER_BIT, gl.NEAREST
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return false;
    this.width = width;
    this.height = height;
    this.dispose();
    this.handle = this.gl.createFramebuffer();
    this._build();
    return true;
  }

  dispose() {
    const gl = this.gl;
    gl.deleteFramebuffer(this.handle);
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.colorRenderbuffer) gl.deleteRenderbuffer(this.colorRenderbuffer);
    if (this.depthRenderbuffer) gl.deleteRenderbuffer(this.depthRenderbuffer);
    this.texture = null;
    this.colorRenderbuffer = null;
    this.depthRenderbuffer = null;
  }
}

export class DepthTexture {
  constructor(gl, width, height) {
    this.gl = gl;
    this.width = width;
    this.height = height;
    this.texture = createTexture2D(gl, {
      width, height,
      internalFormat: gl.DEPTH_COMPONENT24,
      format: gl.DEPTH_COMPONENT,
      type: gl.UNSIGNED_INT,
      wrapS: gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE,
      minFilter: gl.LINEAR, magFilter: gl.LINEAR, mips: false,
    });
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.bindTexture(gl.TEXTURE_2D, null);

    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.texture, 0);
    this.status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.width, this.height);
    return this;
  }
}

/* ---------------------------------------------------------------- helpers - */

export function bindTexture(gl, unit, texture, target = gl.TEXTURE_2D) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(target, texture);
}
