/**
 * A recording WebGL2 mock. It is not a GPU, but it is strict about the things
 * that go wrong in real code:
 *
 *   - shader sources are parsed and linted at compile time
 *   - programs expose exactly the uniforms declared in their GLSL, so setting an
 *     undeclared uniform is a no-op just like on a real driver
 *   - vertex/fragment varyings must match by name and type
 *   - texture uploads are size checked
 *   - draw calls, state changes and framebuffer completeness are recorded
 */

import { lintGlsl, parseUniforms, parseVaryings } from './glsl-lint.mjs';

const TYPE_MAP = {
  float: 'FLOAT',
  int: 'INT',
  bool: 'BOOL',
  vec2: 'FLOAT_VEC2',
  vec3: 'FLOAT_VEC3',
  vec4: 'FLOAT_VEC4',
  ivec2: 'INT_VEC2',
  ivec3: 'INT_VEC3',
  ivec4: 'INT_VEC4',
  mat2: 'FLOAT_MAT2',
  mat3: 'FLOAT_MAT3',
  mat4: 'FLOAT_MAT4',
  sampler2D: 'SAMPLER_2D',
  samplerCube: 'SAMPLER_CUBE',
  sampler2DShadow: 'SAMPLER_2D_SHADOW',
};

export class GlMock {
  constructor(options = {}) {
    this.problems = [];
    this.calls = new Map();
    this.drawCalls = 0;
    this.triangles = 0;
    this.textures = [];
    this.programs = [];
    this.uniformSets = new Map();
    this._reported = new Set();
    this.maxSamples = options.maxSamples ?? 4;
    this.floatBuffers = options.floatBuffers !== false;
    this._nextId = 1;
    this._constants = new Map();
    this._state = { program: null, vao: null, framebuffer: null };

    const handler = {
      get: (target, prop) => {
        if (prop in target) return target[prop];
        if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) {
          if (!target._constants.has(prop)) {
            target._constants.set(prop, 0x1000 + target._constants.size);
          }
          return target._constants.get(prop);
        }
        return undefined;
      },
    };
    return new Proxy(this, handler);
  }

  const(name) {
    if (!this._constants.has(name)) this._constants.set(name, 0x1000 + this._constants.size);
    return this._constants.get(name);
  }

  record(name) {
    this.calls.set(name, (this.calls.get(name) || 0) + 1);
  }

  fail(message) {
    this.problems.push(message);
    throw new Error('GL mock: ' + message);
  }

  /* ------------------------------------------------------------ identity */
  createShader(type) { this.record('createShader'); return { __shader: true, type, id: this._nextId++ }; }
  shaderSource(shader, source) { shader.source = source; }
  compileShader(shader) {
    this.record('compileShader');
    const stage = shader.type === this.const('VERTEX_SHADER') ? 'vertex' : 'fragment';
    shader.lint = lintGlsl(shader.source, stage, `${stage} shader #${shader.id}`);
    shader.compiled = shader.lint.length === 0;
    if (!shader.compiled) this.problems.push(...shader.lint);
  }
  getShaderParameter(shader, pname) {
    if (pname === this.const('COMPILE_STATUS')) return shader.compiled !== false;
    return 0;
  }
  getShaderInfoLog(shader) { return (shader.lint || []).join('\n'); }
  deleteShader() { this.record('deleteShader'); }

  createProgram() { this.record('createProgram'); return { __program: true, id: this._nextId++, shaders: [] }; }
  attachShader(program, shader) { program.shaders.push(shader); }
  linkProgram(program) {
    this.record('linkProgram');
    const vertex = program.shaders.find((s) => s.type === this.const('VERTEX_SHADER'));
    const fragment = program.shaders.find((s) => s.type === this.const('FRAGMENT_SHADER'));
    program.uniforms = parseUniforms([vertex?.source, fragment?.source]);

    if (vertex && fragment) {
      const vsOut = parseVaryings(vertex.source);
      const fsIn = parseVaryings(fragment.source);
      program.varyingProblems = [];
      for (const [name, info] of fsIn) {
        if (info.direction !== 'in') continue;
        const source = vsOut.get(name);
        if (!source) program.varyingProblems.push(`fragment input '${name}' has no vertex output`);
        else if (source.type !== info.type) {
          program.varyingProblems.push(`varying '${name}' type mismatch: ${source.type} vs ${info.type}`);
        }
      }
      for (const problem of program.varyingProblems) {
        this.problems.push(`program #${program.id}: ${problem}`);
      }
    }
    program.linked = true;
    this.programs.push(program);
  }
  getProgramParameter(program, pname) {
    if (pname === this.const('LINK_STATUS')) return program.linked !== false;
    if (pname === this.const('ACTIVE_UNIFORMS')) return program.uniforms ? program.uniforms.size : 0;
    return 0;
  }
  getProgramInfoLog() { return ''; }
  deleteProgram() { this.record('deleteProgram'); }
  useProgram(program) { this._state.program = program; this.record('useProgram'); }

  getActiveUniform(program, index) {
    const entries = [...program.uniforms.entries()];
    if (index >= entries.length) return null;
    const [name, info] = entries[index];
    return {
      name: info.size > 1 ? `${name}[0]` : name,
      type: this.const(TYPE_MAP[info.type] || 'FLOAT'),
      size: info.size,
    };
  }
  getUniformLocation(program, name) {
    const clean = name.replace(/\[0\]$/, '');
    if (!program.uniforms.has(clean)) return null;
    return { __uniform: clean, program };
  }

  /* ----------------------------------------------------------- uniforms */
  _setUniform(location, values, components, name) {
    this.record('uniform');
    if (!location) return;
    const list = typeof values === 'number' ? [values] : Array.from(values);
    if (list.length === 0) this.fail(`${name}: empty uniform value`);
    if (list.length % components !== 0) {
      this.fail(`${name}: ${list.length} values is not a multiple of ${components}`);
    }
    for (const value of list) {
      if (!Number.isFinite(value)) {
        const key = `non-finite uniform ${location.__uniform}`;
        if (!this._reported.has(key)) {
          this._reported.add(key);
          this.problems.push(key);
        }
      }
    }
    this.uniformSets.set(location.__uniform, list.length / components);
  }
  uniform1f(loc, v) { this._setUniform(loc, v, 1, 'uniform1f'); }
  uniform1i(loc, v) { this._setUniform(loc, v, 1, 'uniform1i'); }
  uniform2fv(loc, v) { this._setUniform(loc, v, 2, 'uniform2fv'); }
  uniform3fv(loc, v) { this._setUniform(loc, v, 3, 'uniform3fv'); }
  uniform4fv(loc, v) { this._setUniform(loc, v, 4, 'uniform4fv'); }
  uniform2iv(loc, v) { this._setUniform(loc, v, 2, 'uniform2iv'); }
  uniform3iv(loc, v) { this._setUniform(loc, v, 3, 'uniform3iv'); }
  uniformMatrix3fv(loc, transpose, v) { this._setUniform(loc, v, 9, 'uniformMatrix3fv'); }
  uniformMatrix4fv(loc, transpose, v) { this._setUniform(loc, v, 16, 'uniformMatrix4fv'); }

  /* --------------------------------------------------------------- state */
  enable(cap) { this.record('enable:' + this.nameOf(cap)); }
  disable(cap) { this.record('disable:' + this.nameOf(cap)); }
  depthFunc() { this.record('depthFunc'); }
  depthMask() { this.record('depthMask'); }
  cullFace() { this.record('cullFace'); }
  frontFace() { this.record('frontFace'); }
  blendFunc(a, b) { this.record('blendFunc'); this._blend = [a, b]; }
  clearColor() { this.record('clearColor'); }
  clear() { this.record('clear'); }
  viewport(w, h) { this.record('viewport'); this._viewport = [w, h]; }
  pixelStorei() { this.record('pixelStorei'); }
  activeTexture() { this.record('activeTexture'); }

  nameOf(value) {
    for (const [name, id] of this._constants) if (id === value) return name;
    return String(value);
  }

  /* -------------------------------------------------------------- buffers */
  createBuffer() { return { __buffer: true, id: this._nextId++ }; }
  bindBuffer(target, buffer) { this.record('bindBuffer'); this._buffer = buffer; }
  bufferData(target, data) {
    this.record('bufferData');
    if (!data) this.fail('bufferData called with no data');
    if (data.byteLength === 0) this.fail('bufferData called with an empty buffer');
  }
  deleteBuffer() { this.record('deleteBuffer'); }
  enableVertexAttribArray(index) {
    this.record('enableVertexAttribArray');
    if (index > 3) this.fail('attribute location ' + index + ' is outside the 0..3 layout');
  }
  vertexAttribPointer(index, size, type, normalized, stride, offset) {
    this.record('vertexAttribPointer');
    if (stride && (offset + size * 4) > stride) {
      this.fail(`attribute ${index} overruns the ${stride} byte stride`);
    }
  }
  createVertexArray() { return { __vao: true, id: this._nextId++ }; }
  bindVertexArray(vao) { this._state.vao = vao; this.record('bindVertexArray'); }
  deleteVertexArray() { this.record('deleteVertexArray'); }

  /* ------------------------------------------------------------- textures */
  createTexture() {
    const texture = { __texture: true, id: this._nextId++, faces: 0, uploads: 0 };
    this.textures.push(texture);
    return texture;
  }
  bindTexture(target, texture) { this.record('bindTexture'); this._texture = texture; }
  texImage2D(target, level, internalFormat, ...rest) {
    this.record('texImage2D');
    const texture = this._texture;
    if (!texture) this.fail('texImage2D without a bound texture');
    texture.uploads++;
    // Two call shapes:
    //   (…, width, height, border, format, type, pixels)  -> 7 rest args
    //   (…, format, type, source)                         -> 3 rest args
    if (rest.length >= 6) {
      const [width, height, , format, , data] = rest;
      if (data && typeof data.length === 'number') {
        const channels = format === this.const('RGBA') ? 4 : format === this.const('RGB') ? 3 : 1;
        const expected = width * height * channels;
        if (data.length !== expected) {
          this.fail(`texImage2D ${width}x${height} expected ${expected} values, got ${data.length}`);
        }
      }
      texture.width = width;
      texture.height = height;
    } else if (rest.length === 3) {
      const source = rest[2];
      if (!source) this.fail('texImage2D from a missing source');
      else if (source.width !== undefined) {
        texture.width = source.width;
        texture.height = source.height;
      }
    } else {
      this.fail(`texImage2D called with ${rest.length} unexpected arguments`);
    }
  }
  texSubImage2D(target, level, x, y, format, type, source) {
    this.record('texSubImage2D');
    if (!source) this.fail('texSubImage2D without a source');
    if (source.width === undefined && !source.length) this.fail('texSubImage2D source has no dimensions');
  }
  texParameteri() { this.record('texParameteri'); }
  texParameterf() { this.record('texParameterf'); }
  generateMipmap() { this.record('generateMipmap'); }
  deleteTexture() { this.record('deleteTexture'); }

  /* ---------------------------------------------------------- framebuffers */
  createFramebuffer() { return { __fbo: true, id: this._nextId++, attachments: 0 }; }
  bindFramebuffer(target, fbo) { this._state.framebuffer = fbo; this.record('bindFramebuffer'); }
  framebufferTexture2D(target, attachment, textarget, texture) {
    this.record('framebufferTexture2D');
    if (this._state.framebuffer) this._state.framebuffer.attachments++;
  }
  framebufferRenderbuffer(target, attachment, rendertarget, rb) {
    this.record('framebufferRenderbuffer');
    if (this._state.framebuffer) this._state.framebuffer.attachments++;
  }
  checkFramebufferStatus() { return this.const('FRAMEBUFFER_COMPLETE'); }
  deleteFramebuffer() { this.record('deleteFramebuffer'); }
  createRenderbuffer() { return { __rbo: true, id: this._nextId++ }; }
  bindRenderbuffer() { this.record('bindRenderbuffer'); }
  renderbufferStorage(target, format, w, h) {
    this.record('renderbufferStorage');
    if (w <= 0 || h <= 0) this.fail(`renderbufferStorage ${w}x${h}`);
  }
  renderbufferStorageMultisample(target, samples, format, w, h) {
    this.record('renderbufferStorageMultisample');
    if (samples > this.maxSamples) this.fail(`asked for ${samples} samples, max is ${this.maxSamples}`);
    if (w <= 0 || h <= 0) this.fail(`renderbufferStorageMultisample ${w}x${h}`);
  }
  deleteRenderbuffer() { this.record('deleteRenderbuffer'); }
  blitFramebuffer(...args) {
    this.record('blitFramebuffer');
    if (args.some((v) => !Number.isFinite(v))) this.fail('blitFramebuffer with NaN bounds');
  }
  readPixels() { this.record('readPixels'); }

  /* ---------------------------------------------------------------- draws */
  drawElements(mode, count, type, offset) {
    this.record('drawElements');
    if (!Number.isFinite(count) || count <= 0) this.fail(`drawElements count=${count}`);
    if (!this._state.vao) this.problems.push('drawElements without a bound VAO');
    this.drawCalls++;
    this.triangles += count / 3;
  }
  drawArrays(mode, first, count) {
    this.record('drawArrays');
    if (!Number.isFinite(count) || count <= 0) this.fail(`drawArrays count=${count}`);
    this.drawCalls++;
    this.triangles += count / 3;
  }

  /* ------------------------------------------------------------- queries */
  getParameter(pname) {
    if (pname === this.const('MAX_SAMPLES')) return this.maxSamples;
    if (pname === this.const('MAX_TEXTURE_SIZE')) return 8192;
    if (pname === this.const('RENDERER')) return 'GL mock (software)';
    if (pname === this.const('VENDOR')) return 'NEx3D test harness';
    return 0;
  }
  getExtension(name) {
    if (name === 'EXT_color_buffer_float') return this.floatBuffers ? {} : null;
    if (name === 'EXT_texture_filter_anisotropic') {
      return { MAX_TEXTURE_MAX_ANISOTROPY_EXT: this.const('MAX_ANISO'), TEXTURE_MAX_ANISOTROPY_EXT: this.const('ANISO') };
    }
    return null;
  }
}
